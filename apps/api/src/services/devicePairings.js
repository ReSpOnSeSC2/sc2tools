"use strict";

const { LIMITS } = require("../config/constants");
const { randomDigits, randomToken, sha256 } = require("../util/hash");

const PAIRING_TTL_MS = LIMITS.PAIRING_CODE_TTL_SEC * 1000;

/**
 * Device-pairing flow. Stages:
 *
 *   1. AGENT  → POST /v1/device-pairings/start (no auth)
 *      Returns {code, expiresAt}. Agent shows the code to the user.
 *
 *   2. WEB    → POST /v1/device-pairings/claim (Clerk JWT)
 *      Body {code}. Binds the code to the signed-in user.
 *
 *   3. AGENT  → GET /v1/device-pairings/<code>
 *      Polls. Returns 202 until claimed, then 200 with a long-lived
 *      device token (the only time the raw token is ever sent).
 *
 *   4. AGENT  → POST /v1/games  with `Authorization: Bearer <token>`
 */
class DevicePairingsService {
  /**
   * @param {{
   *   devicePairings: import('mongodb').Collection,
   *   deviceTokens: import('mongodb').Collection,
   * }} db
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Step 1. Agent kicks off pairing.
   *
   * @returns {Promise<{code: string, expiresAt: Date}>}
   */
  async start() {
    const now = Date.now();
    const expiresAt = new Date(now + PAIRING_TTL_MS);
    // Loop a few times to handle the (cosmologically unlikely) collision.
    for (let i = 0; i < 5; i++) {
      const code = randomDigits(LIMITS.PAIRING_CODE_LEN);
      try {
        await this.db.devicePairings.insertOne({
          code,
          createdAt: new Date(now),
          expiresAt,
          claimedAt: null,
          userId: null,
          consumedAt: null,
        });
        return { code, expiresAt };
      } catch (err) {
        const code = /** @type {any} */ (err)?.code;
        if (code !== 11000) throw err;
      }
    }
    throw new Error("could_not_allocate_pairing_code");
  }

  /**
   * Step 2. User signs in on the web and submits the code from their
   * agent. We bind the code to their userId.
   *
   * @param {string} userId
   * @param {string} code
   */
  async claim(userId, code) {
    if (!userId || !code) throw httpErr(400, "bad_request");
    const res = await this.db.devicePairings.findOneAndUpdate(
      { code, userId: null, expiresAt: { $gt: new Date() } },
      { $set: { userId, claimedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!res) throw httpErr(404, "pairing_not_found");
  }

  /**
   * Step 3. Agent polls. Returns:
   *   - {status: 'pending'}    code exists but unclaimed
   *   - {status: 'expired'}    code expired/missing
   *   - {status: 'ready', deviceToken, userId}  one-shot — token only
   *     returned the first time, then the row is consumed.
   *
   * @param {string} code
   * @returns {Promise<
   *   | {status: 'pending'}
   *   | {status: 'expired'}
   *   | {status: 'ready', deviceToken: string, userId: string}
   * >}
   */
  async poll(code) {
    if (!code) throw httpErr(400, "bad_request");
    const row = await this.db.devicePairings.findOne({ code });
    if (!row || row.expiresAt < new Date()) {
      return /** @type {const} */ ({ status: "expired" });
    }
    if (!row.userId) return /** @type {const} */ ({ status: "pending" });
    if (row.consumedAt) {
      // Token was already issued; subsequent polls don't re-issue.
      return /** @type {const} */ ({ status: "expired" });
    }
    const token = randomToken(32);
    const tokenHash = sha256(token);
    const now = new Date();
    await this.db.deviceTokens.insertOne({
      tokenHash,
      userId: row.userId,
      createdAt: now,
      lastSeenAt: now,
      pairingCode: code,
      revokedAt: null,
    });
    await this.db.devicePairings.updateOne(
      { code },
      { $set: { consumedAt: now } },
    );
    return {
      status: /** @type {'ready'} */ ("ready"),
      deviceToken: token,
      userId: String(row.userId),
    };
  }

  /**
   * Used by auth middleware: look up a token (caller has already
   * sha256'd the bearer value).
   *
   * @param {string} tokenHash
   * @returns {Promise<{userId: string}|null>}
   */
  async findTokenByHash(tokenHash) {
    const row = await this.db.deviceTokens.findOne({
      tokenHash,
      revokedAt: null,
    });
    if (!row) return null;
    // Best-effort lastSeenAt bump — failure is non-fatal.
    this.db.deviceTokens
      .updateOne({ tokenHash }, { $set: { lastSeenAt: new Date() } })
      .catch(() => {});
    return { userId: row.userId };
  }

  /**
   * List a user's active devices.
   *
   * @param {string} userId
   */
  async listDevices(userId) {
    return this.db.deviceTokens
      .find(
        { userId, revokedAt: null },
        { projection: { _id: 0, tokenHash: 0 } },
      )
      .sort({ lastSeenAt: -1 })
      .toArray();
  }

  /**
   * Revoke one device token. The caller must own it.
   *
   * @param {string} userId
   * @param {string} tokenHash
   */
  async revoke(userId, tokenHash) {
    await this.db.deviceTokens.updateOne(
      { userId, tokenHash },
      { $set: { revokedAt: new Date() } },
    );
  }
}

/** @param {number} status @param {string} code */
function httpErr(status, code) {
  const err = /** @type {Error & {status: number, code: string}} */ (
    new Error(code)
  );
  err.status = status;
  err.code = code;
  return err;
}

module.exports = { DevicePairingsService };
