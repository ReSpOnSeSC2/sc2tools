"use strict";
const { randomBytes } = require("crypto");
const { sha256 } = require("../util/hash");
const { appendPulseId } = require("./appendPulseId");
const DEVICE_ID = /^[a-f0-9]{24}$/;
const TOON = /^[0-9]+-S2-[0-9]+-[0-9]+$/;
const RETRY_REASONS = new Set(["player_unresolved", "parse_failed", "analysis_failed", "file_unstable", "playback_budget_exceeded", "unsupported_replay"]);
const ACK_CODES = new Set(["accepted", "no_matches", "busy", "expired", "owner_changed", "unsupported", "invalid_request", "local_error"]);
/** @param {number} status @param {string} code */
const fail = (status, code) => Object.assign(new Error(code), { status, code });
/** @param {unknown} body @param {string[]} keys @returns {Record<string,any>} */
function exactBody(body, keys) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== keys.length
      || keys.some(key => !Object.hasOwn(body, key))) throw fail(400, "sync_fix_invalid");
  return /** @type {Record<string,any>} */ (body);
}
/** @template T @param {Promise<T>} promise @param {number} ms @param {string} code @returns {Promise<T>} */
function bounded(promise, ms, code) {
  /** @type {NodeJS.Timeout|undefined} */ let timer;
  /** @type {Promise<never>} */ const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(fail(503, code)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

class SyncHealthFixes {
  /** @param {{users:import('mongodb').Collection<any>, pairings:{findTokenByHash(hash:string):Promise<{userId:string,deviceId:string}|null>},io?:{in(room:string):{fetchSockets():Promise<any[]>}},timeoutMs?:number,now?:()=>number}} deps */
  constructor(deps) {
    this.deps = deps; this.now = deps.now || Date.now;
    this.timeout = Math.min(15000, Math.max(20, deps.timeoutMs ?? 10000));
    /** @type {Set<string>} */ this.pending = new Set();
  }
  /** @param {string} owner @param {unknown} raw */
  async identity(owner, raw) {
    const body = exactBody(raw, ["toonHandle"]);
    if (typeof body.toonHandle !== "string" || body.toonHandle.length > 32 || !TOON.test(body.toonHandle)) throw fail(400, "sync_identity_invalid");
    // Database errors can contain filter values. Keep the private identity out
    // of the shared HTTP error logger as well as the public error envelope.
    let result;
    try { result = await appendPulseId(this.deps.users, owner, body.toonHandle); }
    catch { throw fail(503, "sync_identity_unavailable"); }
    if (result.code === "capacity") throw fail(409, "sync_identity_capacity");
    if (result.code === "missing") throw fail(404, "sync_owner_missing");
    if (result.code === "busy") throw fail(409, "sync_identity_busy");
    return { code: result.code, count: result.count };
  }
  /** One bounded presence read, never a broadcast. @param {string} owner */
  async devices(owner) {
    const sockets = this.deps.io ? await bounded(this.deps.io.in(`user:${owner}`).fetchSockets(), 1000, "sync_presence_unavailable") : [];
    return sockets.filter((/** @type {any} */ socket) => socket.data?.kind === "device" && String(socket.data.userId) === owner
      && DEVICE_ID.test(socket.data.deviceId)).slice(0, 32);
  }
  /** Re-read authoritative device credentials before dispatch and acceptance.
   * No bearer/hash ever leaves the server or enters a log. @param {any} device @param {string} owner */
  async current(device, owner) {
    const token = device.handshake?.auth?.deviceToken;
    if (typeof token !== "string" || !token) return false;
    const hit = await bounded(this.deps.pairings.findTokenByHash(sha256(token)), 1000, "sync_auth_unavailable");
    return hit?.userId === owner && hit.deviceId === device.data.deviceId;
  }
  /** @param {string} owner @param {unknown} raw */
  async retry(owner, raw) {
    const body = exactBody(raw, ["deviceId", "reason"]);
    if (typeof body.deviceId !== "string" || !DEVICE_ID.test(body.deviceId) || typeof body.reason !== "string" || !RETRY_REASONS.has(body.reason)) throw fail(400, "sync_retry_invalid");
    if (this.pending.has(owner)) throw fail(409, "sync_retry_pending");
    if (this.pending.size >= 64) throw fail(503, "sync_retry_capacity");
    this.pending.add(owner);
    try {
      const device = (await this.devices(owner)).find((/** @type {any} */ socket) => socket.data.deviceId === body.deviceId);
      if (!device || !await this.current(device, owner)) throw fail(409, "sync_agent_offline");
      if (device.data.syncRetryVersion !== 1) throw fail(409, "sync_agent_unsupported");
      const requestId = randomBytes(16).toString("hex"), sessionId = device.id;
      if (typeof sessionId !== "string" || !sessionId) throw fail(409, "sync_agent_offline");
      const expiresAt = this.now() + this.timeout;
      const payload = { requestId, deviceId: body.deviceId, sessionId, reason: body.reason, expiresAt };
      /** @type {NodeJS.Timeout|undefined} */ let timer;
      const reply = await Promise.race([device.timeout(this.timeout).emitWithAck("sync:retry-request", payload), new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(fail(504, "sync_retry_unknown")), this.timeout);
      })]).finally(() => clearTimeout(timer));
      if (this.now() >= expiresAt) throw fail(504, "sync_retry_expired");
      if (!reply || typeof reply !== "object" || Array.isArray(reply) || reply.requestId !== requestId || reply.deviceId !== body.deviceId
          || reply.sessionId !== sessionId || reply.reason !== body.reason || !ACK_CODES.has(reply.code)
          || !Number.isSafeInteger(reply.count) || reply.count < 0 || reply.count > 999999
          || (reply.code !== "accepted" && reply.count !== 0)) throw fail(502, "sync_retry_invalid_ack");
      const current = (await this.devices(owner)).find((/** @type {any} */ socket) => socket.id === sessionId && socket.data.deviceId === body.deviceId);
      if (!current || !await this.current(current, owner)) throw fail(409, "sync_owner_changed");
      if (this.now() >= expiresAt) throw fail(504, "sync_retry_expired");
      return { code: reply.code, count: reply.count, requestId, deviceId: body.deviceId };
    } catch (error) { throw /** @type {any} */ (error)?.status ? error : fail(504, "sync_retry_unknown"); }
    finally { this.pending.delete(owner); }
  }
}
module.exports = { SyncHealthFixes, RETRY_REASONS };
