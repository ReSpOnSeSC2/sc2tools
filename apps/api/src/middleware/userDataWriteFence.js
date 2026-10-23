"use strict";
const { randomUUID } = require("crypto");
const LEASE_MS = 15 * 60 * 1000;
// All authenticated user writes participate in erasure exclusion. These
// operations own their own exclusive fence or act on a different target user.
const UNFENCED_PATH = /^\/(?:v1\/)?(?:admin(?:\/|$)|webhooks(?:\/|$)|me(?:$|\/(?:backups|repair|games\/wipe)(?:\/|$)))/;

/** @param {import('mongodb').Collection<any>} users @param {string} userId */
async function claimUserDataLease(users, userId) {
  const id = randomUUID(); const now = new Date();
  const active = { $filter: { input: { $ifNull: ["$_dataMutations", []] }, as: "write", cond: { $gt: ["$$write.leaseUntil", now] } } };
  const result = await users.updateOne({ userId, _gdprMutation: { $exists: false }, $expr: { $lt: [{ $size: active }, 100] } }, [{ $set: {
    _dataMutations: { $concatArrays: [active, [{ id, leaseUntil: new Date(now.getTime() + LEASE_MS) }]] },
  } }]);
  if (!result.matchedCount) throw Object.assign(new Error("gdpr_operation_busy"), { status: 409, code: "gdpr_operation_busy" });
  let lost = false;
  const assert = async () => {
    if (lost) throw new Error("data_write_lease_lost");
    const renewed = await users.updateOne({ userId, "_dataMutations.id": id }, { $set: { "_dataMutations.$.leaseUntil": new Date(Date.now() + LEASE_MS) } });
    if (!renewed.matchedCount) { lost = true; throw new Error("data_write_lease_lost"); }
  };
  const timer = setInterval(() => { void assert().catch(() => { lost = true; }); }, 60_000); timer.unref?.();
  return { assert, stopRenewing: () => clearInterval(timer), release: async () => {
    clearInterval(timer);
    await users.updateOne({ userId }, [{ $set: { _dataMutations: { $filter: { input: { $ifNull: ["$_dataMutations", []] }, as: "write", cond: { $ne: ["$$write.id", id] } } } } }]);
  } };
}

/** Register authenticated writes on the same users row claimed by GDPR. The
 * guard never clears a GDPR lock, including expired locks. Interrupted HTTP
 * responses keep their expiring write lease because the handler may still be
 * writing; a normal finished response releases it immediately.
 * @param {import('express').RequestHandler} auth
 * @param {import('mongodb').Collection<any>} users
 * @returns {import('express').RequestHandler}
 */
function withUserDataWriteFence(auth, users) {
  const registered = new WeakSet();
  return (req, res, next) => auth(req, res, (error) => {
    if (error) { next(error); return; }
    if (!req.auth || !["POST", "PUT", "PATCH", "DELETE"].includes(req.method) || UNFENCED_PATH.test(req.originalUrl.split("?", 1)[0]) || registered.has(req)) { next(); return; }
    void claimUserDataLease(users, req.auth.userId).then(async (lease) => {
      if (res.destroyed) { await lease.release(); return; }
      registered.add(req);
      res.once("finish", () => {
        void lease.release().catch((err) => req.log?.warn({ err }, "data_write_lease_release_failed"));
      });
      res.once("close", lease.stopRenewing);
      next();
    }).catch(next);
  });
}
module.exports = { withUserDataWriteFence, claimUserDataLease, UNFENCED_PATH };
