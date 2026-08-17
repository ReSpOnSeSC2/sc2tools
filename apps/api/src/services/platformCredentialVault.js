"use strict";

const {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

const TOKEN_VERSION = 1;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const WEBHOOK_RECEIPT_TTL_MS = 48 * 60 * 60 * 1000;
const PLATFORMS = new Set(["twitch", "kick", "youtube"]);

/**
 * Parse the dedicated platform-token key. Accepting both hex and base64 makes
 * Render setup less error-prone while still requiring exactly 256 bits.
 *
 * @param {string|Buffer} raw
 * @returns {Buffer}
 */
function parseTokenEncryptionKey(raw) {
  if (Buffer.isBuffer(raw)) {
    if (raw.length !== 32) throw new Error("platform token key must be 32 bytes");
    return Buffer.from(raw);
  }
  const value = String(raw || "").trim();
  let key;
  if (/^[0-9a-f]{64}$/i.test(value)) {
    key = Buffer.from(value, "hex");
  } else {
    try {
      key = /^[A-Za-z0-9+/]{43}=$/.test(value)
        ? Buffer.from(value, "base64")
        : Buffer.alloc(0);
    } catch {
      key = Buffer.alloc(0);
    }
  }
  if (key.length !== 32) {
    throw new Error(
      "PLATFORM_TOKEN_ENCRYPTION_KEY must be 64 hex characters or base64 for exactly 32 bytes",
    );
  }
  return key;
}

/** @param {string} platform */
function assertPlatform(platform) {
  if (!PLATFORMS.has(platform)) throw new Error("unsupported platform");
}

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * AES-256-GCM envelope. AAD binds a secret to its owner/platform/field, so a
 * copied ciphertext cannot be replayed in another user's connection row.
 *
 * @param {string} value
 * @param {Buffer} key
 * @param {string} aad
 */
function encryptSecret(value, key, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final(),
  ]);
  return {
    v: TOKEN_VERSION,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: ciphertext.toString("base64url"),
  };
}

/**
 * @param {{v?: unknown, iv?: unknown, tag?: unknown, data?: unknown}} envelope
 * @param {Buffer} key
 * @param {string} aad
 */
function decryptSecret(envelope, key, aad) {
  if (
    !envelope ||
    envelope.v !== TOKEN_VERSION ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.data !== "string"
  ) {
    throw new Error("invalid encrypted platform credential");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

class PlatformCredentialVault {
  /**
   * @param {{
   *   platformConnections: import('mongodb').Collection,
   *   platformOauthStates: import('mongodb').Collection,
   *   platformWebhookReceipts: import('mongodb').Collection,
   * }} db
   * @param {{encryptionKey: string|Buffer, now?: () => number}} opts
   */
  constructor(db, opts) {
    this.connections = db.platformConnections;
    this.oauthStates = db.platformOauthStates;
    this.receipts = db.platformWebhookReceipts;
    this.key = parseTokenEncryptionKey(opts.encryptionKey);
    this.now = opts.now || Date.now;
  }

  /**
   * @param {string} userId
   * @param {'twitch'|'kick'|'youtube'} platform
   * @param {{
   *   accessToken: string,
   *   refreshToken?: string|null,
   *   expiresAt?: Date|null,
   *   scopes?: string[],
   *   platformUserId: string,
   *   platformUserName?: string,
   *   metadata?: Record<string, unknown>,
   * }} value
   */
  async saveConnection(userId, platform, value) {
    assertPlatform(platform);
    if (!userId || !value.platformUserId || !value.accessToken) {
      throw new Error("incomplete platform connection");
    }
    const aadBase = `connection:${userId}:${platform}`;
    const now = new Date(this.now());
    // Every successful OAuth install gets a fresh opaque revision. Background
    // workers must present it when writing, so an in-flight request from a
    // previous account cannot overwrite a newly reconnected account.
    const connectionRevision = randomBytes(16).toString("base64url");
    const set = stampVersion({
      userId,
      platform,
      connectionRevision,
      platformUserId: String(value.platformUserId),
      platformUserName: String(value.platformUserName || "").slice(0, 100),
      accessToken: encryptSecret(value.accessToken, this.key, `${aadBase}:access`),
      refreshToken: value.refreshToken
        ? encryptSecret(value.refreshToken, this.key, `${aadBase}:refresh`)
        : null,
      expiresAt: value.expiresAt instanceof Date ? value.expiresAt : null,
      scopes: Array.from(new Set(value.scopes || [])).map(String).slice(0, 32),
      metadata:
        value.metadata && typeof value.metadata === "object"
          ? value.metadata
          : {},
      connected: true,
      connectedAt: now,
      updatedAt: now,
    }, COLLECTIONS.PLATFORM_CONNECTIONS);
    await this.connections.updateOne(
      { userId, platform },
      { $set: set, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
    return this.statusFromRow(set);
  }

  /**
   * @param {string} userId
   * @param {'twitch'|'kick'|'youtube'} platform
   */
  async getConnection(userId, platform) {
    assertPlatform(platform);
    const row = await this.connections.findOne({ userId, platform, connected: true });
    if (!row) return null;
    const aadBase = `connection:${userId}:${platform}`;
    return {
      ...this.statusFromRow(row),
      connectionRevision: String(row.connectionRevision || ""),
      accessToken: decryptSecret(row.accessToken, this.key, `${aadBase}:access`),
      refreshToken: row.refreshToken
        ? decryptSecret(row.refreshToken, this.key, `${aadBase}:refresh`)
        : null,
      metadata:
        row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    };
  }

  /** @param {Record<string, any>} row */
  statusFromRow(row) {
    return {
      platform: row.platform,
      connected: row.connected === true,
      ready: row.platform === "youtube"
        ? row.metadata?.youtubeInitialized === true && !row.metadata?.lastError
        : row.metadata?.subscriptionsReady === true,
      platformUserId: String(row.platformUserId || ""),
      platformUserName: String(row.platformUserName || ""),
      scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
      expiresAt: row.expiresAt instanceof Date ? row.expiresAt : null,
      connectedAt: row.connectedAt instanceof Date ? row.connectedAt : null,
      lastSyncedAt: row.metadata?.lastSyncedAt instanceof Date
        ? row.metadata.lastSyncedAt
        : null,
      lastError: typeof row.metadata?.lastError === "string"
        ? row.metadata.lastError.slice(0, 240)
        : null,
    };
  }

  /** @param {string} userId */
  async statuses(userId) {
    const rows = await this.connections
      .find({ userId, connected: true })
      .project({ accessToken: 0, refreshToken: 0 })
      .toArray();
    return rows.map((row) => this.statusFromRow(row));
  }

  /**
   * @param {string} userId
   * @param {'twitch'|'kick'|'youtube'} platform
   */
  async disconnect(userId, platform, expectedRevision = "") {
    assertPlatform(platform);
    /** @type {Record<string, any>} */
    const filter = { userId, platform };
    if (expectedRevision) filter.connectionRevision = expectedRevision;
    const out = await this.connections.deleteOne(filter);
    return out.deletedCount > 0;
  }

  /** Resolve a signed webhook broadcaster without decrypting any token. */
  /** @param {string} platform @param {string} platformUserId */
  async findOwnerByPlatformIdentity(platform, platformUserId) {
    assertPlatform(platform);
    if (!platformUserId) return null;
    const row = await this.connections.findOne(
      { platform, platformUserId: String(platformUserId), connected: true },
      { projection: { _id: 0, userId: 1 } },
    );
    return row?.userId ? String(row.userId) : null;
  }

  /**
   * Internal polling surface. Secrets are decrypted only for the bounded set
   * of connected rows and are never returned by an HTTP route.
   * @param {string} platform
   * @param {number} [limit]
   */
  async listConnections(platform, limit = 500) {
    assertPlatform(platform);
    const rows = await this.connections
      .find({ platform, connected: true })
      .limit(Math.max(1, Math.min(2_000, Number(limit) || 500)))
      .toArray();
    return rows.map((row) => {
      const userId = String(row.userId || "");
      const aadBase = `connection:${userId}:${platform}`;
      return {
        ...this.statusFromRow(row),
        userId,
        connectionRevision: String(row.connectionRevision || ""),
        accessToken: decryptSecret(row.accessToken, this.key, `${aadBase}:access`),
        refreshToken: row.refreshToken
          ? decryptSecret(row.refreshToken, this.key, `${aadBase}:refresh`)
          : null,
        metadata: row.metadata && typeof row.metadata === "object"
          ? row.metadata
          : {},
      };
    });
  }

  /**
   * @param {string} userId
   * @param {string} platform
   * @param {{accessToken:string, refreshToken?:string|null, expiresAt?:Date|null, scopes?:string[]}} value
   * @param {string} [expectedRevision]
   */
  async updateTokens(userId, platform, value, expectedRevision = "") {
    assertPlatform(platform);
    const aadBase = `connection:${userId}:${platform}`;
    /** @type {Record<string, any>} */
    const set = {
      accessToken: encryptSecret(value.accessToken, this.key, `${aadBase}:access`),
      expiresAt: value.expiresAt instanceof Date ? value.expiresAt : null,
      updatedAt: new Date(this.now()),
    };
    if (value.refreshToken) {
      set.refreshToken = encryptSecret(
        value.refreshToken,
        this.key,
        `${aadBase}:refresh`,
      );
    }
    if (Array.isArray(value.scopes) && value.scopes.length > 0) {
      set.scopes = Array.from(new Set(value.scopes)).map(String).slice(0, 32);
    }
    /** @type {Record<string, any>} */
    const filter = { userId, platform, connected: true };
    if (expectedRevision) filter.connectionRevision = expectedRevision;
    const out = await this.connections.updateOne(
      filter,
      { $set: set },
    );
    return out.matchedCount > 0;
  }

  /**
   * @param {string} userId
   * @param {string} platform
   * @param {Record<string, any>} patch
   * @param {string} [expectedRevision]
   */
  async updateMetadata(userId, platform, patch, expectedRevision = "") {
    assertPlatform(platform);
    const safe = patch && typeof patch === "object" ? patch : {};
    /** @type {Record<string, any>} */
    const set = { updatedAt: new Date(this.now()) };
    for (const [key, value] of Object.entries(safe)) {
      if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)) continue;
      set[`metadata.${key}`] = value;
    }
    /** @type {Record<string, any>} */
    const filter = { userId, platform, connected: true };
    if (expectedRevision) filter.connectionRevision = expectedRevision;
    const out = await this.connections.updateOne(
      filter,
      { $set: set },
    );
    return out.matchedCount > 0;
  }

  /**
   * Lightweight compare-and-swap guard used before publishing provider data.
   * @param {string} userId
   * @param {string} platform
   * @param {string} expectedRevision
   */
  async isConnectionCurrent(userId, platform, expectedRevision) {
    assertPlatform(platform);
    if (!expectedRevision) return false;
    const row = await this.connections.findOne({
      userId,
      platform,
      connected: true,
      connectionRevision: expectedRevision,
    });
    return Boolean(row);
  }

  /**
   * @param {{
   *   userId: string,
   *   platform: 'twitch'|'kick'|'youtube',
   *   redirectUri: string,
   *   codeVerifier?: string|null,
   * }} input
   */
  async createOauthState(input) {
    assertPlatform(input.platform);
    const state = randomBytes(32).toString("base64url");
    const stateHash = sha256(state);
    const createdAt = new Date(this.now());
    const expiresAt = new Date(createdAt.getTime() + OAUTH_STATE_TTL_MS);
    await this.oauthStates.insertOne(stampVersion({
      stateHash,
      userId: input.userId,
      platform: input.platform,
      redirectUri: input.redirectUri,
      codeVerifier: input.codeVerifier
        ? encryptSecret(
          input.codeVerifier,
          this.key,
          `oauth:${stateHash}:verifier`,
        )
        : null,
      createdAt,
      expiresAt,
    }, COLLECTIONS.PLATFORM_OAUTH_STATES));
    return state;
  }

  /**
   * Atomically consume state so a captured callback URL cannot be replayed.
   * @param {string} state
   * @param {'twitch'|'kick'|'youtube'} platform
   */
  async consumeOauthState(state, platform) {
    assertPlatform(platform);
    if (typeof state !== "string" || state.length < 32 || state.length > 200) {
      return null;
    }
    const stateHash = sha256(state);
    const result = await this.oauthStates.findOneAndDelete({
      stateHash,
      platform,
      expiresAt: { $gt: new Date(this.now()) },
    });
    // mongodb@6 returns the document directly; small test doubles and older
    // driver shapes may return {value}. Supporting both is harmless.
    const row = result && Object.prototype.hasOwnProperty.call(result, "value")
      ? result.value
      : result;
    if (!row) return null;
    return {
      userId: String(row.userId),
      redirectUri: String(row.redirectUri || ""),
      codeVerifier: row.codeVerifier
        ? decryptSecret(
          row.codeVerifier,
          this.key,
          `oauth:${stateHash}:verifier`,
        )
        : null,
    };
  }

  /**
   * First writer wins for each official webhook message id. The unique index
   * is the cross-process guard; the TTL keeps the collection bounded.
   * @param {'twitch'|'kick'} platform
   * @param {string} messageId
   */
  async claimWebhookReceipt(platform, messageId) {
    if (platform !== "twitch" && platform !== "kick") {
      throw new Error("unsupported webhook platform");
    }
    if (!messageId || messageId.length > 200) return false;
    const receivedAt = new Date(this.now());
    try {
      await this.receipts.insertOne(stampVersion({
        platform,
        messageId,
        receivedAt,
        expiresAt: new Date(receivedAt.getTime() + WEBHOOK_RECEIPT_TTL_MS),
      }, COLLECTIONS.PLATFORM_WEBHOOK_RECEIPTS));
      return true;
    } catch (err) {
      if (err && /** @type {any} */ (err).code === 11000) return false;
      throw err;
    }
  }
}

module.exports = {
  PlatformCredentialVault,
  parseTokenEncryptionKey,
  encryptSecret,
  decryptSecret,
  OAUTH_STATE_TTL_MS,
  WEBHOOK_RECEIPT_TTL_MS,
};
