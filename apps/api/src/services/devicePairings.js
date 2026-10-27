"use strict";

const { ObjectId } = require("mongodb");
const { LIMITS, COLLECTIONS } = require("../config/constants");
const { randomDigits, randomToken, sha256 } = require("../util/hash");
const { stampVersion } = require("../db/schemaVersioning");
const { claimUserDataLease } = require("../middleware/userDataWriteFence");
const { DeviceLiveness, DEVICE_TOUCH_MS } = require("./deviceLiveness");

const PAIRING_TTL_MS = LIMITS.PAIRING_CODE_TTL_SEC * 1000;
// One API instance serves the ten-minute code lifetime. A restart safely turns
// the network hint into a mismatch; raw addresses are never persisted.
const PROCESS_IP_SALT = randomToken(32);

/** @param {unknown} value @param {number} max */
function safeMetadata(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, max) : "";
}

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
   *   users: import('mongodb').Collection,
   * }} db
   * @param {{ adminEvents?: import('./adminEvents').AdminEventsService,
   *   logger?: import('pino').Logger, ipSalt?: string, liveness?: DeviceLiveness }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.adminEvents = opts.adminEvents || null;
    this.logger = opts.logger || null;
    /** @type {((userId: string, metadata: any) => Promise<void>)|null} */
    this.onHeartbeat = null;
    this.ipSalt = opts.ipSalt || PROCESS_IP_SALT;
    this.liveness = opts.liveness || new DeviceLiveness();
  }

  /** Always active, including when the independent chart cache is disabled.
   * @param {string} userId @returns {()=>void} */
  beginLivenessMutation(userId) { return this.liveness.begin(userId); }

  /**
   * Step 1. Agent kicks off pairing.
   *
   * @param {{hostname?: unknown, os?: unknown, version?: unknown}|null} [metadata]
   * @param {string} [ip]
   * @returns {Promise<{code: string, expiresAt: Date}>}
   */
  async start(metadata = {}, ip = "") {
    const input = metadata && typeof metadata === "object" ? metadata : {};
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
              deviceId: new ObjectId(),
              hostname: safeMetadata(input.hostname, 64),
              os: safeMetadata(input.os, 64),
              version: safeMetadata(input.version, 40),
              startIpHash: ip ? sha256(`${this.ipSalt}\0${ip}`) : null,
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
  async claim(userId, code, ip = "") {
    if (!userId || !/^\d{6}$/.test(code)) throw httpErr(400, "bad_request");
    const res = await this.db.devicePairings.findOneAndUpdate(
      { code, userId: null, expiresAt: { $gt: new Date() } },
      { $set: { userId, claimedAt: new Date() } },
      { returnDocument: "after" },
    );
    // Read failure state only after the atomic claim, so expiry and a racing
    // claimant get the correct response without a preview/claim time window.
    if (!res) {
      await this.preview(code, ip);
      throw httpErr(409, "pairing_already_claimed");
    }
    return this.pairingInfo(res, ip);
  }

  /** Authenticated preview for the explicit device confirmation.
   * @param {string} code @param {string} [ip]
   */
  async preview(code, ip = "") {
    if (!/^\d{6}$/.test(code)) throw httpErr(400, "bad_request");
    const row = await this.db.devicePairings.findOne({ code, expiresAt: { $gt: new Date() } });
    if (!row) throw httpErr(404, "pairing_not_found");
    if (row.userId) throw httpErr(409, "pairing_already_claimed");
    return this.pairingInfo(row, ip);
  }

  /** @param {Record<string, any>} row @param {string} ip */
  pairingInfo(row, ip) {
    return {
      sameNetwork: Boolean(ip && row.startIpHash && row.startIpHash === sha256(`${this.ipSalt}\0${ip}`)),
      device: { deviceId: String(row.deviceId || row._id), hostname: row.hostname || "", os: row.os || "", version: row.version || "" },
    };
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
    // Poll is intentionally public: the generic authenticated-write fence
    // cannot cover token issuance. Admit it before consuming a claimed code
    // so a late poll cannot recreate a device after account erasure.
    let lease;
    try { lease = await claimUserDataLease(this.db.users, row.userId); }
    catch (error) {
      if (/** @type {any} */ (error)?.status === 409) return /** @type {const} */ ({ status: "expired" });
      throw error;
    }
    try {
    const token = randomToken(32);
    const tokenHash = sha256(token);
    const now = new Date();
    const claimed = await this.db.devicePairings.findOneAndUpdate(
      { code, userId: row.userId, consumedAt: null, expiresAt: { $gt: now } },
      { $set: { consumedAt: now } },
      { returnDocument: "after" },
    );
    if (!claimed) return /** @type {const} */ ({ status: "expired" });
    const finishDevices = this.beginLivenessMutation(row.userId);
    try { await this.db.deviceTokens.insertOne(
      stampVersion(
        {
          tokenHash,
          _id: row.deviceId || row._id,
          userId: row.userId,
          createdAt: now,
          lastSeenAt: null,
          hostname: row.hostname || "",
          agentOs: row.os || "",
          agentVersion: row.version || "",
          pairingCode: code,
          revokedAt: null,
        },
        COLLECTIONS.DEVICE_TOKENS,
      ),
    ); } catch (err) {
      // A lost write acknowledgement can throw after Mongo inserted the row.
      // Never reopen a code that already issued a token; its reserved id also
      // prevents duplicate device rows. Retry only a confirmed failed insert.
      const issued = await this.db.deviceTokens.findOne(
        { _id: row.deviceId || row._id }, { projection: { _id: 1 } },
      );
      if (!issued) await this.db.devicePairings.updateOne({ code, consumedAt: now }, { $set: { consumedAt: null } });
      throw err;
    } finally { finishDevices(); }
    return {
      status: /** @type {'ready'} */ ("ready"),
      deviceToken: token,
      userId: String(row.userId),
    };
    } finally { await lease.release(); }
  }

  /**
   * Used by auth middleware: look up a token (caller has already
   * sha256'd the bearer value).
   *
   * @param {string} tokenHash
   * @returns {Promise<{userId: string, deviceId: string}|null>}
   */
  async findTokenByHash(tokenHash) {
    const row = await this.db.deviceTokens.findOne({ tokenHash, revokedAt: null },
      { projection: { _id: 1, userId: 1, lastSeenAt: 1 } });
    if (!row) return null;
    const now = new Date(this.liveness.now()), cutoff = new Date(now.getTime() - DEVICE_TOUCH_MS);
    if (!(row.lastSeenAt instanceof Date) || !Number.isFinite(row.lastSeenAt.getTime()) || row.lastSeenAt <= cutoff) {
      // One authoritative lookup per request remains. The stale predicate is
      // evaluated at the write, so an old REST touch cannot roll back heartbeat.
      void this.liveness.touch(row.userId, tokenHash, () => this.db.deviceTokens.updateOne({
        _id: row._id, userId: row.userId, tokenHash, revokedAt: null, $or: [
          { lastSeenAt: { $lte: cutoff } }, { $expr: { $ne: [{ $type: "$lastSeenAt" }, "date"] } },
        ],
      }, { $set: { lastSeenAt: now } }, { upsert: false }));
    }
    return { userId: row.userId, deviceId: String(row._id) };
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
   *   label?: string,
   *   agentVersion?: string,
   *   agentOs?: string,
   *   agentOsRelease?: string,
   * }>>}
   */
  async listDevices(userId) {
    const rows = await this.db.deviceTokens
      .find(
        { userId, revokedAt: null },
        // Explicit public fields keep pairing codes and future private auth
        // metadata out of the web response as well as the bearer-token hash.
        { projection: { _id: 1, userId: 1, createdAt: 1, lastSeenAt: 1,
          hostname: 1, label: 1, agentVersion: 1, agentOs: 1, agentOsRelease: 1 } },
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
   * @returns {Promise<{paired: boolean, version: string|null, lastSeenAt: Date|null}>}
   */
  async latestAgent(userId) {
    return this.liveness.latest(userId, () => this.readLatestAgent(userId));
  }

  /** @param {string} userId */
  async readLatestAgent(userId) {
    const row = await this.db.deviceTokens.findOne(
      { userId, revokedAt: null },
      {
        sort: { lastSeenAt: -1 },
        projection: { _id: 0, agentVersion: 1, lastSeenAt: 1 },
      },
    );
    if (!row) return { paired: false, version: null, lastSeenAt: null };
    const version =
      typeof row.agentVersion === "string" && row.agentVersion.length > 0
        ? row.agentVersion
        : null;
    // Heartbeat and minute-throttled REST liveness keep "agent online"
    // derivable client-side as lastSeenAt within the last ~3 minutes.
    const lastSeenAt = row.lastSeenAt instanceof Date ? row.lastSeenAt : null;
    return { paired: true, version, lastSeenAt };
  }

  /**
   * Revoke one device token. The caller must own it.
   *
   * @param {string} userId
   * @param {string} tokenHash
   */
  async revoke(userId, tokenHash) {
    await this.liveness.mutate(userId, () => this.db.deviceTokens.updateOne(
      { userId, tokenHash },
      { $set: { revokedAt: new Date() } },
    ));
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
    } catch {
      return false;
    }
    const res = await this.liveness.mutate(userId, () => this.db.deviceTokens.updateOne(
      { _id, userId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    ));
    return res.matchedCount > 0;
  }

  /** @param {string} userId @param {string} deviceId @param {unknown} label */
  async setLabel(userId, deviceId, label) {
    if (typeof label !== "string" || label.trim().length > 40 || /[\u0000-\u001f\u007f]/.test(label)) throw httpErr(400, "bad_request");
    if (!ObjectId.isValid(deviceId)) return false;
    const result = await this.db.deviceTokens.updateOne(
      { _id: new ObjectId(deviceId), userId, revokedAt: null },
      { $set: { label: label.trim() } },
    );
    return result.matchedCount > 0;
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
    const now = new Date(this.liveness.now());
    /** @type {Record<string, unknown>} */
    const update = {};
    if (body && typeof body.version === "string") {
      update.agentVersion = safeMetadata(body.version, 64);
    }
    if (body && typeof body.os === "string") {
      update.agentOs = safeMetadata(body.os, 32);
    }
    if (body && typeof body.osRelease === "string") {
      update.agentOsRelease = safeMetadata(body.osRelease, 64);
    }
    // Hostnames are usually short and ASCII, but we cap defensively
    // (a 64-char limit easily fits any practical machine name) and
    // ignore empty strings so an unset hostname doesn't blow away a
    // previously-recorded one.
    if (body && typeof body.hostname === "string") {
      const trimmed = safeMetadata(body.hostname, 64);
      if (trimmed) update.hostname = trimmed;
    }
    const fields = Object.fromEntries(Object.entries(update).map(([key, value]) => [key, { $literal: value }]));
    const lastSeenAt = { $cond: [{ $eq: [{ $type: "$lastSeenAt" }, "date"] },
      { $max: ["$lastSeenAt", { $literal: now }] }, { $literal: now }] };
    const device = await this.liveness.mutate(userId, () => this.db.deviceTokens.findOneAndUpdate(
      { userId, tokenHash, revokedAt: null },
      [{ $set: { ...fields, lastSeenAt } }],
      {
        returnDocument: "after",
        projection: { _id: 1, userId: 1, createdAt: 1, agentVersion: 1,
          agentOs: 1, connectedEventRecordedAt: 1 },
      },
    ));
    if (device && !device.connectedEventRecordedAt && this.adminEvents) {
      // A notification outage must not break the agent. Leave the marker
      // unset until the durable write succeeds; its next heartbeat retries.
      try {
        const event = await this.adminEvents.recordAgentConnection(device);
        if (event) {
          await this.db.deviceTokens.updateOne(
            { _id: device._id, userId, revokedAt: null },
            { $set: { connectedEventRecordedAt: now } },
          );
        }
      } catch (err) {
        if (this.logger) {
          this.logger.warn({ err, deviceId: String(device._id) }, "agent_connection_notification_failed");
        }
      }
    }
    if (device && this.onHeartbeat) {
      try { await this.onHeartbeat(userId, body); }
      catch (err) { this.logger?.warn({ err }, "agent_update_notification_failed"); }
    }
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
