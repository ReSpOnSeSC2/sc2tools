"use strict";

/**
 * Private original-.SC2Replay storage backed by Cloudflare R2 (or another
 * S3-compatible service).
 *
 * Uploads and downloads travel directly between the client and R2 through
 * short-lived presigned URLs. The API keeps the bucket credentials private,
 * derives every object key from the authenticated user, and only marks a
 * replay downloadable after HEAD + four-byte MPQ validation succeeds.
 */

const {
  S3Client,
  PutObjectCommand,
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { randomBytes } = require("crypto");

const { LIMITS } = require("../config/constants");

const REPLAY_CONTENT_TYPE = "application/octet-stream";
const UPLOAD_EXPIRES_SEC = 5 * 60;
const DOWNLOAD_EXPIRES_SEC = 60;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MPQ_USER_DATA = Buffer.from([0x4d, 0x50, 0x51, 0x1b]);
const MPQ_ARCHIVE = Buffer.from([0x4d, 0x50, 0x51, 0x1a]);

class ReplayFilesService {
  /**
   * @param {{
   *   client: import('@aws-sdk/client-s3').S3Client,
   *   bucket: string,
   *   prefix?: string,
   *   games: import('mongodb').Collection,
   *   signer?: typeof getSignedUrl,
   *   uploadExpiresSec?: number,
   *   downloadExpiresSec?: number,
   * }} opts
   */
  constructor(opts) {
    if (!opts || !opts.client || !opts.bucket || !opts.games) {
      throw new Error("ReplayFilesService: client, bucket, and games required");
    }
    this.client = opts.client;
    this.bucket = opts.bucket;
    this.prefix = (opts.prefix || "raw-replays/v1").replace(/^\/+|\/+$/g, "");
    this.pendingPrefix = `${this.prefix}-pending`;
    this.games = opts.games;
    this.signer = opts.signer || getSignedUrl;
    this.uploadExpiresSec = clampExpiry(
      opts.uploadExpiresSec,
      UPLOAD_EXPIRES_SEC,
    );
    this.downloadExpiresSec = clampExpiry(
      opts.downloadExpiresSec,
      DOWNLOAD_EXPIRES_SEC,
    );
  }

  /** @param {string} userId @param {string} gameId */
  keyFor(userId, gameId) {
    return `${this.prefix}/${encodeURIComponent(userId)}/${encodeURIComponent(gameId)}.SC2Replay`;
  }

  /** @param {string} userId @param {string} gameId @param {string} uploadId */
  pendingKeyFor(userId, gameId, uploadId) {
    return `${this.pendingPrefix}/${encodeURIComponent(userId)}/${encodeURIComponent(gameId)}/${uploadId}.SC2Replay`;
  }

  /**
   * @param {string} userId
   * @param {string} gameId
   * @param {{filename: string, sizeBytes: number, sha256: string, md5: string}} file
   */
  async prepareUpload(userId, gameId, file) {
    const game = await this._ownedGame(userId, gameId);
    if (!game) throw httpError(404, "game_not_found");

    if (
      markerMatchesFile(game.replayFile, file)
      && await this._objectMatchesMarker(
        this.keyFor(userId, gameId),
        game.replayFile,
      )
    ) {
      return { alreadyStored: true, replayAvailable: true };
    }

    const now = new Date();
    const activeIntent = game.replayUpload;
    if (activeIntent && isFutureDate(activeIntent.expiresAt, now)) {
      if (
        activeIntent.state !== "pending"
        || !intentMatchesFile(activeIntent, file)
      ) {
        throw httpError(409, "replay_upload_busy");
      }
      const refreshed = await this.games.updateOne(
        {
          userId,
          gameId,
          "replayUpload.uploadId": activeIntent.uploadId,
          "replayUpload.state": "pending",
        },
        {
          $set: {
            "replayUpload.expiresAt": new Date(
              now.getTime() + this.uploadExpiresSec * 2000,
            ),
          },
        },
      );
      if (!refreshed.matchedCount) throw httpError(409, "replay_upload_busy");
      return this._signPendingUpload(userId, gameId, activeIntent.uploadId, file);
    }

    const uploadId = randomBytes(18).toString("base64url");
    const intent = {
      uploadId,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      md5: file.md5,
      state: "pending",
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.uploadExpiresSec * 2000),
    };
    /** @type {Record<string, any>} */
    const intentFilter = { userId, gameId };
    if (game.replayUpload?.uploadId) {
      intentFilter["replayUpload.uploadId"] = game.replayUpload.uploadId;
      if (game.replayUpload.state) {
        intentFilter["replayUpload.state"] = game.replayUpload.state;
      }
    } else {
      intentFilter.replayUpload = { $exists: false };
    }
    const pending = await this.games.updateOne(
      intentFilter,
      { $set: { replayUpload: intent } },
    );
    if (!pending.matchedCount) throw httpError(409, "replay_upload_busy");

    return this._signPendingUpload(userId, gameId, uploadId, file);
  }

  /**
   * @param {string} userId
   * @param {string} gameId
   * @param {string} uploadId
   * @param {{sizeBytes: number, sha256: string, md5: string}} file
   */
  async _signPendingUpload(userId, gameId, uploadId, file) {
    const key = this.pendingKeyFor(userId, gameId, uploadId);
    const headers = {
      "content-type": REPLAY_CONTENT_TYPE,
      "content-length": String(file.sizeBytes),
      "cache-control": "private, no-store",
      "content-md5": file.md5,
      "x-amz-meta-sha256": file.sha256,
    };
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: REPLAY_CONTENT_TYPE,
      ContentLength: file.sizeBytes,
      CacheControl: "private, no-store",
      ContentMD5: file.md5,
      Metadata: { sha256: file.sha256 },
    });
    const url = await this.signer(this.client, command, {
      expiresIn: this.uploadExpiresSec,
      // Metadata headers are hoisted into the query string by default. Keep
      // this one as a signed header because the agent applies the returned
      // header map verbatim and completion reads it back through HEAD.
      unhoistableHeaders: new Set(["x-amz-meta-sha256"]),
      signableHeaders: new Set([
        "content-type",
        "cache-control",
        "content-md5",
      ]),
    });
    return { url, headers, uploadId, expiresIn: this.uploadExpiresSec };
  }

  /**
   * Verify that the direct upload is complete and is plausibly an SC2 replay,
   * then expose it through the owning game's server-controlled marker.
   *
   * @param {string} userId
   * @param {string} gameId
   * @param {string} uploadId
   */
  async completeUpload(userId, gameId, uploadId) {
    const game = await this._ownedGame(userId, gameId);
    if (!game) throw httpError(404, "game_not_found");
    const finalKey = this.keyFor(userId, gameId);
    const pendingKey = this.pendingKeyFor(userId, gameId, uploadId);

    // A lost completion response is safe to retry. The marker carries only
    // the opaque upload nonce (never an object key or credential).
    if (
      game.replayFile?.uploadId === uploadId
      && await this._objectMatchesMarker(finalKey, game.replayFile)
    ) {
      await this._deleteKey(pendingKey);
      return game.replayFile;
    }

    const intent = game.replayUpload;
    if (!intent || intent.uploadId !== uploadId) {
      throw httpError(409, "replay_upload_expired");
    }
    if (!isFutureDate(intent.expiresAt, new Date())) {
      try {
        await this._deleteKey(pendingKey);
      } finally {
        await this._clearIntent(userId, gameId, uploadId);
      }
      throw httpError(409, "replay_upload_expired");
    }
    if (intent.state !== "pending") {
      throw httpError(409, "replay_upload_busy");
    }
    const claim = await this.games.updateOne(
      {
        userId,
        gameId,
        "replayUpload.uploadId": uploadId,
        "replayUpload.state": "pending",
      },
      {
        $set: {
          "replayUpload.state": "completing",
          "replayUpload.expiresAt": new Date(
            Date.now() + this.uploadExpiresSec * 1000,
          ),
        },
      },
    );
    if (!claim.matchedCount) throw httpError(409, "replay_upload_busy");

    let head;
    try {
      head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: pendingKey }),
      );
    } catch (err) {
      await this._releaseIntent(userId, gameId, uploadId);
      if (isNotFoundError(err)) throw httpError(409, "replay_upload_missing");
      throw err;
    }

    const sizeBytes = Number(head.ContentLength);
    const sha256 = String(head.Metadata?.sha256 || "").toLowerCase();
    if (
      !Number.isSafeInteger(sizeBytes)
      || sizeBytes < 4
      || sizeBytes > LIMITS.REPLAY_FILE_MAX_BYTES
      || !SHA256_HEX.test(sha256)
      || sizeBytes !== Number(intent.sizeBytes)
      || sha256 !== String(intent.sha256 || "").toLowerCase()
    ) {
      try {
        await this._deleteKey(pendingKey);
      } finally {
        await this._clearIntent(userId, gameId, uploadId);
      }
      throw httpError(400, "invalid_replay_upload_metadata");
    }

    let prefix;
    try {
      const object = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: pendingKey,
          Range: "bytes=0-3",
        }),
      );
      prefix = await bodyToBuffer(object.Body, 4);
    } catch (err) {
      await this._releaseIntent(userId, gameId, uploadId);
      if (isNotFoundError(err)) throw httpError(409, "replay_upload_missing");
      throw err;
    }
    if (!looksLikeReplay(prefix)) {
      try {
        await this._deleteKey(pendingKey);
      } finally {
        await this._clearIntent(userId, gameId, uploadId);
      }
      throw httpError(400, "not_a_replay");
    }

    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: finalKey,
          CopySource: encodeCopySource(this.bucket, pendingKey),
          MetadataDirective: "COPY",
        }),
      );
    } catch (err) {
      await this._releaseIntent(userId, gameId, uploadId);
      throw err;
    }

    const storedAt = new Date();
    const marker = {
      version: 1,
      uploadId,
      sizeBytes,
      sha256,
      md5: intent.md5,
      storedAt,
    };
    const update = await this.games.updateOne(
      {
        userId,
        gameId,
        "replayUpload.uploadId": uploadId,
        "replayUpload.state": "completing",
      },
      {
        $set: { replayFile: marker },
        $unset: { replayUpload: "" },
      },
    );
    if (!update.matchedCount) {
      await Promise.all([
        this._deleteKey(finalKey),
        this._deleteKey(pendingKey),
      ]);
      const owner = await this._ownedGame(userId, gameId);
      throw httpError(owner ? 409 : 404, owner ? "replay_upload_expired" : "game_not_found");
    }
    await this._deleteKey(pendingKey);
    return marker;
  }

  /** @param {string} userId @param {string} gameId */
  async prepareDownload(userId, gameId) {
    const game = await this._ownedGame(userId, gameId);
    if (!game) throw httpError(404, "game_not_found");
    if (!game.replayFile || !game.replayFile.storedAt) {
      throw httpError(404, "replay_unavailable");
    }
    const key = this.keyFor(userId, gameId);
    // A completed marker and its object must continue to agree. This catches
    // an externally removed/replaced object before handing a signed URL to
    // the browser and self-heals the stale database marker.
    if (!await this._objectMatchesMarker(key, game.replayFile)) {
      await this._clearMarker(userId, gameId, game.replayFile.storedAt);
      throw httpError(404, "replay_unavailable");
    }
    const filename = replayDownloadFilename(game);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentType: REPLAY_CONTENT_TYPE,
      ResponseContentDisposition: contentDisposition(filename),
    });
    const url = await this.signer(this.client, command, {
      expiresIn: this.downloadExpiresSec,
    });
    return { url, filename, expiresIn: this.downloadExpiresSec };
  }

  /** @param {string} userId @param {string} gameId */
  async delete(userId, gameId) {
    await this._deleteKey(this.keyFor(userId, gameId));
    await this._deletePrefix(this._pendingGamePrefix(userId, gameId));
  }

  /** @param {string} userId @param {string[]} gameIds */
  async deleteMany(userId, gameIds) {
    const ids = Array.from(
      new Set((Array.isArray(gameIds) ? gameIds : []).filter(Boolean)),
    );
    if (ids.length === 0) return;
    for (let i = 0; i < ids.length; i += 1000) {
      const keys = ids.slice(i, i + 1000).map((gameId) => ({
        Key: this.keyFor(userId, gameId),
      }));
      if (keys.length === 0) continue;
      const response = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keys, Quiet: true },
        }),
      );
      assertDeleteSucceeded(response);
    }
    // Cancel every in-flight pending upload for the user in one bounded
    // prefix walk. A ranged wipe may cancel an unrelated upload, but that
    // agent safely obtains a fresh nonce on retry; this avoids 10k LIST calls.
    await this._deletePrefix(
      `${this.pendingPrefix}/${encodeURIComponent(userId)}/`,
    );
  }

  /** @param {string} userId */
  async deleteAllForUser(userId) {
    await this._deletePrefix(`${this.prefix}/${encodeURIComponent(userId)}/`);
    await this._deletePrefix(
      `${this.pendingPrefix}/${encodeURIComponent(userId)}/`,
    );
  }

  /** @param {string} prefix */
  async _deletePrefix(prefix) {
    let continuationToken;
    do {
      /** @type {import('@aws-sdk/client-s3').ListObjectsV2Output} */
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const objects = (page.Contents || [])
        .filter((item) => item && item.Key)
        .map((item) => ({ Key: item.Key }));
      if (objects.length > 0) {
        const response = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
        assertDeleteSucceeded(response);
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);
  }

  /** @param {string} userId @param {string} gameId */
  async _ownedGame(userId, gameId) {
    return this.games.findOne(
      { userId, gameId },
      {
        projection: {
          _id: 0,
          gameId: 1,
          date: 1,
          map: 1,
          opponent: 1,
          replayFile: 1,
          replayUpload: 1,
        },
      },
    );
  }

  /** @param {string} key */
  async _deleteKey(key) {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  }

  /** @param {string} userId @param {string} gameId */
  _pendingGamePrefix(userId, gameId) {
    return `${this.pendingPrefix}/${encodeURIComponent(userId)}/${encodeURIComponent(gameId)}/`;
  }

  /** @param {string} userId @param {string} gameId @param {string} uploadId */
  async _releaseIntent(userId, gameId, uploadId) {
    await this.games.updateOne(
      {
        userId,
        gameId,
        "replayUpload.uploadId": uploadId,
        "replayUpload.state": "completing",
      },
      { $set: { "replayUpload.state": "pending" } },
    );
  }

  /** @param {string} userId @param {string} gameId @param {string} uploadId */
  async _clearIntent(userId, gameId, uploadId) {
    await this.games.updateOne(
      { userId, gameId, "replayUpload.uploadId": uploadId },
      { $unset: { replayUpload: "" } },
    );
  }

  /** @param {string} key @param {{sizeBytes?: number, sha256?: string}} marker */
  async _objectMatchesMarker(key, marker) {
    let head;
    try {
      head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw err;
    }
    return Number(head.ContentLength) === Number(marker.sizeBytes)
      && String(head.Metadata?.sha256 || "").toLowerCase()
        === String(marker.sha256 || "").toLowerCase();
  }

  /** @param {string} userId @param {string} gameId @param {Date|string} storedAt */
  async _clearMarker(userId, gameId, storedAt) {
    await this.games.updateOne(
      { userId, gameId, "replayFile.storedAt": storedAt },
      { $unset: { replayFile: "" } },
    );
  }
}

/**
 * @param {{games: import('mongodb').Collection}} db
 * @param {{replayFilesStore?: 'disabled'|'r2', r2?: {endpoint?: string, region?: string, bucket?: string, accessKeyId?: string, secretAccessKey?: string, replayPrefix?: string}|null}} config
 */
function buildReplayFilesFromConfig(db, config) {
  const kind = (config && config.replayFilesStore) || "disabled";
  if (kind === "disabled") return null;
  if (kind !== "r2") {
    throw new Error(`Unsupported replay file store: ${kind}`);
  }
  const r2 = config && config.r2;
  if (
    !r2
    || !r2.endpoint
    || !r2.bucket
    || !r2.accessKeyId
    || !r2.secretAccessKey
  ) {
    throw new Error(
      "REPLAY_FILES_STORE=r2 requires R2_ENDPOINT, R2_BUCKET, "
        + "R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY",
    );
  }
  const client = new S3Client({
    region: r2.region || "auto",
    endpoint: r2.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
    },
  });
  return new ReplayFilesService({
    client,
    bucket: r2.bucket,
    prefix: r2.replayPrefix,
    games: db.games,
  });
}

/** @param {Buffer} body */
function looksLikeReplay(body) {
  if (!Buffer.isBuffer(body) || body.length < 4) return false;
  const magic = body.subarray(0, 4);
  return magic.equals(MPQ_USER_DATA) || magic.equals(MPQ_ARCHIVE);
}

/**
 * @param {Record<string, any>|null|undefined} marker
 * @param {{sizeBytes: number, sha256: string, md5: string}} file
 */
function markerMatchesFile(marker, file) {
  return Boolean(
    marker?.storedAt
    && Number(marker.sizeBytes) === file.sizeBytes
    && String(marker.sha256 || "").toLowerCase() === file.sha256
    && String(marker.md5 || "") === String(file.md5 || ""),
  );
}

/**
 * @param {Record<string, any>} intent
 * @param {{sizeBytes: number, sha256: string, md5: string}} file
 */
function intentMatchesFile(intent, file) {
  return Number(intent.sizeBytes) === file.sizeBytes
    && String(intent.sha256 || "").toLowerCase() === file.sha256
    && String(intent.md5 || "") === file.md5;
}

/** @param {string} bucket @param {string} key */
function encodeCopySource(bucket, key) {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${encodeURIComponent(bucket)}/${encodedKey}`;
}

/** @param {unknown} value @param {Date} now */
function isFutureDate(value, now) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  return !Number.isNaN(date.getTime()) && date.getTime() > now.getTime();
}

/** @param {any} body @param {number} maxBytes */
async function bodyToBuffer(body, maxBytes) {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray()).subarray(0, maxBytes);
  }
  if (Buffer.isBuffer(body)) return body.subarray(0, maxBytes);
  const chunks = [];
  let length = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = maxBytes - length;
    if (remaining <= 0) break;
    chunks.push(buf.subarray(0, remaining));
    length += Math.min(buf.length, remaining);
  }
  return Buffer.concat(chunks);
}

/** @param {any} err */
function isNotFoundError(err) {
  return Boolean(
    err
    && (
      err.name === "NoSuchKey"
      || err.name === "NotFound"
      || err.Code === "NoSuchKey"
      || err.$metadata?.httpStatusCode === 404
    )
  );
}

/** @param {any} response */
function assertDeleteSucceeded(response) {
  if (!Array.isArray(response?.Errors) || response.Errors.length === 0) return;
  const first = response.Errors[0] || {};
  const err = new Error(
    `replay_object_delete_failed:${first.Code || "unknown"}`,
  );
  /** @type {any} */ (err).code = "replay_object_delete_failed";
  /** @type {any} */ (err).objects = response.Errors;
  throw err;
}

/** @param {Record<string, any>} game */
function replayDownloadFilename(game) {
  const day = safeFilenamePart(
    game.date instanceof Date
      ? game.date.toISOString().slice(0, 10)
      : String(game.date || "").slice(0, 10),
    "replay",
  );
  const opponent = safeFilenamePart(game.opponent?.displayName, "opponent");
  const map = safeFilenamePart(game.map, "map");
  return `${day}_${opponent}_${map}.SC2Replay`.slice(0, 180);
}

/** @param {unknown} value @param {string} fallback */
function safeFilenamePart(value, fallback) {
  const clean = String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 60);
  return clean || fallback;
}

/** @param {string} filename */
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** @param {unknown} value @param {number} fallback */
function clampExpiry(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(3600, Math.trunc(n)));
}

/** @param {number} status @param {string} code */
function httpError(status, code) {
  const err = /** @type {Error & {status: number, code: string}} */ (
    new Error(code)
  );
  err.status = status;
  err.code = code;
  return err;
}

module.exports = {
  ReplayFilesService,
  buildReplayFilesFromConfig,
  _internals: {
    looksLikeReplay,
    replayDownloadFilename,
    contentDisposition,
    bodyToBuffer,
    isNotFoundError,
  },
};
