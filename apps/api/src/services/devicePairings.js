"use strict";

const { ObjectId } = require("mongodb");
const { LIMITS, COLLECTIONS } = require("../config/constants");
const { randomDigits, randomToken, sha256 } = require("../util/hash");
const { stampVersion } = require("../db/schemaVersioning");

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
        await this.db.devicePairings.insertOne(
          stampVersion(
            {
              code,
              createdAt: new Date(now),
              expiresAt,
              claimedAt: null,
              userId: null,
              consumedAt: null,
            },
            COLLECTIONS.DEVICE_PAIRINGS,
          ),
        );
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
    await this.db.deviceTokens.insertOne(
      stampVersion(
        {
          tokenHash,
          userId: row.userId,
          createdAt: now,
          lastSeenAt: now,
          pairingCode: code,
          revokedAt: null,
        },
        COLLECTIONS.DEVICE_TOKENS,
      ),
    );
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
   * Returns rows with a stable string `deviceId` (the row's `_id` as
   * hex) so the SPA can label and revoke each device without ever
   * seeing the bearer-token hash. Hostname/os/version come from the
   * agent's most recent heartbeat — when the agent hasn't checked in
   * yet, those fields are absent and the UI falls back to whatever
   * pieces are present.
   *
   * @param {string} userId
   * @returns {Promise<Array<{
   *   deviceId: string,
   *   userId: string,
   *   createdAt: Date,
   *   lastSeenAt: Date | null,
   *   hostname?: string,
   *   agentVersion?: string,
   *   agentOs?: string,
   *   agentOsRelease?: string,
   * }>>}
   */
  async listDevices(userId) {
    const rows = await this.db.deviceTokens
      .find(
        { userId, revokedAt: null },
        { projection: { tokenHash: 0 } },
      )
      .sort({ lastSeenAt: -1 })
      .toArray();
    return rows.map((row) => {
      const { _id, ...rest } = /** @type {any} */ (row);
      return { deviceId: String(_id), ...rest };
    });
  }

  /**
   * One-shot summary of the user's most recently active agent. Drives the
   * "Agent version" row on the Settings → Foundation card: callers can
   * distinguish "no agent paired" (paired=false) from "paired but version
   * unknown" (paired=true, version=null) — the latter happens between
   * claim and the first heartbeat.
   *
   * @param {string} userId
   * @returns {Promise<{paired: boolean, version: string|null}>}
   */
  async latestAgent(userId) {
    const row = await this.db.deviceTokens.findOne(
      { userId, revokedAt: null },
      {
        sort: { lastSeenAt: -1 },
        projection: { _id: 0, agentVersion: 1 },
      },
    );
    if (!row) return { paired: false, version: null };
    const version =
      typeof row.agentVersion === "string" && row.agentVersion.length > 0
        ? row.agentVersion
        : null;
    return { paired: true, version };
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

  /**
   * Revoke a device by its row id (the string the SPA receives in
   * `listDevices`). The match is also gated on `userId` so a malicious
   * caller can't unpair somebody else's device by guessing an id.
   *
   * Returns `true` when a row was actually flipped; `false` for an
   * unknown / already-revoked / wrong-owner id, so the route can map
   * that to a 404 instead of silently 204'ing.
   *
   * @param {string} userId
   * @param {string} deviceId
   * @returns {Promise<boolean>}
   */
  async revokeById(userId, deviceId) {
    let _id;
    try {
      _id = new ObjectId(deviceId);
    } catch (_e) {
      return false;
    }
    const res = await this.db.deviceTokens.updateOne(
      { _id, userId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    return res.matchedCount > 0;
  }

  /**
   * Record a heartbeat from an agent. Bumps `lastSeenAt` and stamps
   * the most recent agent metadata (version, OS) so the dashboard can
   * surface "agent is up to date" / "agent appears stopped" badges.
   *
   * The agent posts to /v1/devices/heartbeat with its bearer token;
   * the auth middleware turns that into a userId + tokenHash on
   * `req.auth`. We trust the body's metadata since the bearer was
   * verified, but we cap field lengths defensively.
   *
   * @param {string} userId
   * @param {string} tokenHash
   * @param {{version?: string, os?: string, osRelease?: string, hostname?: string}} body
   */
  async recordHeartbeat(userId, tokenHash, body) {
    const now = new Date();
    /** @type {Record<string, unknown>} */
    const update = { lastSeenAt: now };
    if (body && typeof body.version === "string") {
      update.agentVersion = body.version.slice(0, 64);
    }
    if (body && typeof body.os === "string") {
      update.agentOs = body.os.slice(0, 32);
    }
    if (body && typeof body.osRelease === "string") {
      update.agentOsRelease = body.osRelease.slice(0, 64);
    }
    // Hostnames are usually short and ASCII, but we cap defensively
    // (a 64-char limit easily fits any practical machine name) and
    // ignore empty strings so an unset hostname doesn't blow away a
    // previously-recorded one.
    if (body && typeof body.hostname === "string") {
      const trimmed = body.hostname.trim().slice(0, 64);
      if (trimmed) update.hostname = trimmed;
    }
    await this.db.deviceTokens.updateOne(
      { userId, tokenHash },
      { $set: update },
    );
    return { receivedAt: now };
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
