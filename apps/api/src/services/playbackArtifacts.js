"use strict";
const { LIVE_GAME_MATCH } = require("../util/gameVisibility");

const { createHash, createHmac, randomUUID } = require("crypto");
const { PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { validateManifest, validateSegment, MAX_SEGMENT_BYTES, MAX_MANIFEST_BYTES, SHA } = require("../validation/playbackArtifact");
const { getPlaybackJob } = require("./replayPlaybackJobs");
/** @param {Buffer} body */
const digest = (body) => createHash("sha256").update(body).digest("hex");
/** @param {number} status @param {string} code @param {string} [message] */
const error = (status, code, message = code) => Object.assign(new Error(message), { status, code });

const LEGACY_STORAGE = 1;
const OPAQUE_STORAGE = 2;

/** The matching pending generation owns writes, even when its digest is
 * already published in a different storage layout.
 * @param {any} game @param {string} artifactId */
function writableGeneration(game, artifactId) {
  if (game.playbackUpload?.artifactId === artifactId) return { path: "playbackUpload", marker: game.playbackUpload };
  if (game.playbackArtifact?.artifactId === artifactId) return { path: "playbackArtifact", marker: game.playbackArtifact };
  throw error(404, "playback_artifact_not_found");
}

class PlaybackArtifactsService {
  /** @param {{client: import('@aws-sdk/client-s3').S3Client, bucket: string, games: import('mongodb').Collection, notifications?:Pick<import('./notifications').NotificationsService,'notify'>, keySecret?: Buffer, signer?: typeof getSignedUrl}} options */
  constructor({ client, bucket, games, notifications, keySecret, signer }) {
    if (keySecret !== undefined && (!Buffer.isBuffer(keySecret) || keySecret.length !== 32)) {
      throw new Error("Playback storage key secret must be 32 bytes");
    }
    this.keySecret = keySecret;
    this.client = client;
    this.bucket = bucket;
    this.games = games;
    this.notifications = notifications;
    this.signer = signer || getSignedUrl;
    this.activeReads = 0;
    this.activeWrites = 0;
  }

  /** @param {string} userId @param {string} [gameId] @param {number} [version] */
  prefix(userId, gameId, version = LEGACY_STORAGE) {
    if (version === OPAQUE_STORAGE && this.keySecret) {
      const owner = this.opaqueDirectory("owner", userId);
      const game = gameId == null ? "" : this.opaqueDirectory("game", userId, gameId) + "/";
      return `mapped-playback/v2/${owner}/${game}`;
    }
    if (version !== LEGACY_STORAGE) throw error(502, "playback_storage_layout_unavailable");
    return `mapped-playback/v1/${encodeURIComponent(userId)}/${gameId == null ? "" : `${encodeURIComponent(gameId)}/`}`;
  }

  /** @param {string} kind @param {...string} identities */
  opaqueDirectory(kind, ...identities) {
    if (!this.keySecret) throw error(502, "playback_storage_layout_unavailable");
    return createHmac("sha256", this.keySecret)
      .update(JSON.stringify(["mapped-playback/v2", kind, ...identities]))
      .digest("hex");
  }

  /** @param {{storageVersion?:number}} marker @param {boolean} [requireOpaque] */
  storageVersion(marker, requireOpaque = false) {
    const version = marker.storageVersion ?? LEGACY_STORAGE;
    if (requireOpaque && (version !== OPAQUE_STORAGE || !this.keySecret)) {
      throw error(404, "playback_direct_unavailable", "Use the replay playback endpoint.");
    }
    return version;
  }

  /** @param {string} userId @param {string} gameId @param {string} artifactId @param {string} file @param {number} [version] */
  key(userId, gameId, artifactId, file, version = LEGACY_STORAGE) {
    if (!SHA.test(artifactId)) throw error(400, "invalid_artifact_id");
    return `${this.prefix(userId, gameId, version)}${artifactId}/${file}`;
  }

  /** @param {string} userId @param {string} gameId */
  async owned(userId, gameId) {
    const game = await this.games.findOne({ userId, gameId, ...LIVE_GAME_MATCH }, { projection: { replayFile: 1, playbackArtifact: 1, playbackUpload: 1, myRace: 1, "opponent.race": 1, map: 1 } });
    if (!game) throw error(404, "game_not_found");
    return game;
  }

  /** @param {string} userId @param {string} gameId @param {string} artifactId @param {number} version */
  async stillOwned(userId, gameId, artifactId, version) {
    try { return await this.owned(userId, gameId); }
    catch (cause) {
      if (/** @type {{status?:number}} */ (cause).status === 404) {
        // A GDPR purge may finish while this request's PUT is in flight.
        // Remove that late object rather than leaving an orphan generation.
        await this.deletePrefix(this.key(userId, gameId, artifactId, "", version));
      }
      throw cause;
    }
  }

  /** @template T @param {string} kind @param {() => Promise<T>} fn */
  async bounded(kind, fn) {
    const field = kind === "read" ? "activeReads" : "activeWrites";
    if (this[field] >= (kind === "read" ? 2 : 1)) throw error(503, "playback_artifact_busy");
    this[field] += 1;
    try { return await fn(); } finally { this[field] -= 1; }
  }

  /** @param {string} key @param {number} max */
  async read(key, max) {
    let response;
    try { response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })); }
    catch (e) { if (isMissing(e)) throw error(404, "playback_artifact_not_found"); throw e; }
    if (Number(response.ContentLength) > max) { /** @type {import('stream').Readable|undefined} */ (response.Body)?.destroy(); throw error(502, "playback_artifact_corrupt"); }
    const chunks = [];
    let size = 0;
    for await (const chunk of /** @type {import('stream').Readable} */ (response.Body)) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > max) { /** @type {import('stream').Readable|undefined} */ (response.Body)?.destroy(); throw error(502, "playback_artifact_corrupt"); }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  }

  /** @param {string} userId @param {string} gameId @param {string} artifactId @param {number} version */
  async manifest(userId, gameId, artifactId, version) {
    const body = await this.read(this.key(userId, gameId, artifactId, "manifest.json", version), MAX_MANIFEST_BYTES);
    if (digest(body) !== artifactId) throw error(502, "playback_artifact_corrupt");
    return validateManifest(JSON.parse(body.toString("utf8")));
  }

  /** @param {string} key @param {Buffer} body @param {Record<string,string>} [metadata] */
  async put(key, body, metadata = {}) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body,
      ContentType: "application/json", CacheControl: "private, no-store", Metadata: metadata }));
  }

  /** @param {Record<string,any>} game @param {Record<string,any>} manifest */
  assertSource(game, manifest) {
    if (game.replayFile?.sha256 && game.replayFile.sha256 !== manifest.replaySha256) throw error(409, "playback_replay_mismatch");
  }

  /** @param {string} userId @param {string} gameId @param {unknown} input */
  async prepare(userId, gameId, input) {
    return this.bounded("write", async () => {
      const game = await this.owned(userId, gameId);
      const manifest = validateManifest(input);
      this.assertSource(game, manifest);
      const body = Buffer.from(JSON.stringify(manifest));
      const artifactId = digest(body);
      const pending = game.playbackUpload;
      const sameArtifact = pending?.artifactId === artifactId;
      const version = sameArtifact ? this.storageVersion(pending) : this.keySecret ? OPAQUE_STORAGE : LEGACY_STORAGE;
      const job = getPlaybackJob(userId, gameId);
      const activeJob = job && ["queued", "processing", "uploading"].includes(job.status);
      // A retry can land on a peer that has no in-memory job. Preserve the
      // request already bound to these bytes unless this process knows its status.
      const requestId = activeJob ? job.requestId : !job && sameArtifact ? pending.requestId : undefined;
      const reserved = await this.games.updateOne({
        userId, gameId, ...LIVE_GAME_MATCH,
        playbackUpload: pending === undefined ? { $exists: false } : { $eq: pending },
      }, {
        $set: { playbackUpload: { artifactId, generationId: randomUUID(), preparedAt: new Date(),
          ...(version === OPAQUE_STORAGE ? { storageVersion: version } : {}), ...(requestId ? { requestId } : {}) } },
      });
      if (reserved.matchedCount !== 1) {
        await this.owned(userId, gameId);
        throw error(503, "playback_artifact_busy");
      }
      await this.put(this.key(userId, gameId, artifactId, "manifest.json", version), body);
      await this.stillOwned(userId, gameId, artifactId, version);
      return { ok: true, artifactId };
    });
  }

  /** @param {string} userId @param {string} gameId @param {string} artifactId @param {number} index @param {Buffer|undefined} body */
  async upload(userId, gameId, artifactId, index, body) {
    return this.bounded("write", async () => {
      const game = await this.owned(userId, gameId);
      const { marker } = writableGeneration(game, artifactId);
      const version = this.storageVersion(marker);
      const m = await this.manifest(userId, gameId, artifactId, version);
      this.assertSource(game, m);
      const d = m.segments[index];
      if (!d || !Number.isInteger(index) || index < 0) throw error(400, "invalid_segment_index");
      if (!Buffer.isBuffer(body) || body.length > MAX_SEGMENT_BYTES || body.length !== d.sizeBytes || digest(body) !== d.sha256) throw error(400, "playback_segment_digest_mismatch");
      validateSegment(JSON.parse(body.toString("utf8")), m, d);
      await this.put(this.key(userId, gameId, artifactId, `${index}.json`, version), body, { sha256: d.sha256 });
      await this.stillOwned(userId, gameId, artifactId, version);
      return { ok: true, index, sha256: d.sha256 };
    });
  }

  /** @param {string} userId @param {string} gameId @param {string} artifactId */
  async complete(userId, gameId, artifactId) {
    return this.bounded("write", async () => {
      const game = await this.owned(userId, gameId);
      const { marker, path } = writableGeneration(game, artifactId);
      const version = this.storageVersion(marker);
      const m = await this.manifest(userId, gameId, artifactId, version);
      this.assertSource(game, m);
      // Only this API writes these keys after validating raw bytes; HEAD is a
      // bounded completion proof, avoiding whole-replay hydration on the API.
      for (const s of m.segments) {
        let head;
        try { head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(userId, gameId, artifactId, `${s.index}.json`, version) })); }
        catch (e) { if (isMissing(e)) throw error(409, "playback_segments_incomplete"); throw e; }
        if (Number(head.ContentLength) !== s.sizeBytes || head.Metadata?.sha256 !== s.sha256) throw error(409, "playback_segments_incomplete");
      }
      const requestId = typeof marker.requestId === "string" ? marker.requestId : null;
      const completed = { artifactId, replaySha256: m.replaySha256, segmentCount: m.segments.length, storedAt: new Date(),
        ...(marker.generationId ? { generationId: marker.generationId } : {}),
        ...(version === OPAQUE_STORAGE ? { storageVersion: version } : {}), ...(requestId ? { requestId } : {}) };
      const pending = path === "playbackUpload";
      const result = await this.games.updateOne({
        // Legacy markers have no generationId. Match the whole stored marker
        // in both layouts, including the reservation's request and timestamp.
        userId, gameId, ...LIVE_GAME_MATCH, [path]: { $eq: marker },
        ...(!pending ? { "playbackUpload.artifactId": { $ne: artifactId } } : {}),
      }, { $set: { playbackArtifact: completed }, ...(pending ? { $unset: { playbackUpload: "" } } : {}) });
      const response = { ok: true, artifactId, segmentCount: m.segments.length };
      if (result.matchedCount !== 1) {
        const current = await this.stillOwned(userId, gameId, artifactId, version);
        const published = current.playbackArtifact;
        if (published?.artifactId === artifactId && this.storageVersion(published) === version) return response;
        const newer = current.playbackUpload;
        if (newer?.artifactId === artifactId && this.storageVersion(newer) === version) {
          // The agent already retries this code in place. The next attempt
          // reads the current reservation and attributes its own notification.
          throw error(503, "playback_artifact_busy");
        }
        throw error(409, "playback_artifact_superseded");
      }
      if (requestId && this.notifications) {
        const letter = (/** @type {unknown} */ value) => typeof value === "string" && /^[PTZR]/i.test(value) ? value.charAt(0).toUpperCase() : "?";
        const href = `/app/game/${encodeURIComponent(gameId)}#replay`;
        await this.notifications.notify(userId, { kind: "playback_ready", groupKey: gameId,
          eventKey: `playback_ready:${gameId}:${requestId}`,
          title: `Accurate playback ready: ${letter(game.myRace)}v${letter(game.opponent?.race)} on ${String(game.map || m.mapName).slice(0, 100)}`,
          body: "The recorded playback has finished uploading. Open the game to watch it.", href: href.length <= 300 ? href : "/app/replays" });
      }
      return response;
    });
  }

  /** @param {string} userId @param {string} gameId */
  async getManifest(userId, gameId) {
    return this.bounded("read", async () => {
      const game = await this.owned(userId, gameId);
      const marker = game.playbackArtifact;
      if (!marker?.artifactId) throw error(404, "playback_artifact_not_found");
      const id = marker.artifactId;
      return { ok: true, artifactId: id, manifest: await this.manifest(userId, gameId, id, this.storageVersion(marker)) };
    });
  }

  /** @param {string} userId @param {string} gameId @param {string} artifactId @param {number} index
   * @param {{requireOpaque?:boolean}} [options] */
  async getSegment(userId, gameId, artifactId, index, { requireOpaque = false } = {}) {
    return this.bounded("read", async () => {
      const game = await this.owned(userId, gameId);
      const marker = game.playbackArtifact;
      if (marker?.artifactId !== artifactId) throw error(404, "playback_artifact_not_found");
      const version = this.storageVersion(marker, requireOpaque);
      const m = await this.manifest(userId, gameId, artifactId, version);
      const d = m.segments[index];
      if (!d || !Number.isInteger(index) || index < 0) throw error(404, "playback_artifact_not_found");
      const body = await this.read(this.key(userId, gameId, artifactId, `${index}.json`, version), MAX_SEGMENT_BYTES);
      if (body.length !== d.sizeBytes || digest(body) !== d.sha256) throw error(502, "playback_artifact_corrupt");
      return body;
    });
  }

  /**
   * A short-lived presigned GET for one segment of the game's current
   * completed artifact, so a browser downloads the bytes from storage
   * directly instead of through the API. The completion marker's
   * ``segmentCount`` bounds the index, so no manifest is read here; the
   * browser still checks every byte against the manifest's SHA-256.
   * @param {string} userId @param {string} gameId @param {string} artifactId @param {number} index @param {number} expiresIn seconds
   * @param {{requireOpaque?:boolean}} [options]
   * @returns {Promise<{url: string, expiresIn: number}>}
   */
  async signSegment(userId, gameId, artifactId, index, expiresIn, { requireOpaque = false } = {}) {
    const game = await this.owned(userId, gameId);
    const marker = game.playbackArtifact;
    if (!marker || marker.artifactId !== artifactId || !Number.isInteger(index) || index < 0
        || !Number.isInteger(marker.segmentCount) || index >= marker.segmentCount) throw error(404, "playback_artifact_not_found");
    const version = this.storageVersion(marker, requireOpaque);
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: this.key(userId, gameId, artifactId, `${index}.json`, version) });
    return { url: await this.signer(this.client, command, { expiresIn }), expiresIn };
  }

  /** @param {string} prefix */
  async deletePrefix(prefix) {
    // Repeat listing the first page after deletion: continuation tokens can
    // skip keys when an object list is mutated during GDPR cleanup.
    for (;;) {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: 1000 }));
      const keys = (page.Contents || []).map((o) => ({ Key: o.Key }));
      if (!keys.length) return;
      const result = await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
      if (result.Errors?.length) throw error(502, "playback_artifact_delete_failed");
    }
  }

  /** @param {string} userId @param {string} [gameId] */
  async deleteStored(userId, gameId) {
    await this.deletePrefix(this.prefix(userId, gameId));
    if (this.keySecret) await this.deletePrefix(this.prefix(userId, gameId, OPAQUE_STORAGE));
  }

  /** @param {string} userId */
  async deleteAllForUser(userId) { await this.deleteStored(userId); }
  /** @param {string} userId @param {string[]} gameIds */
  async deleteMany(userId, gameIds) { for (const gameId of gameIds) await this.deleteStored(userId, gameId); }
}

/** @param {unknown} e */
function isMissing(e) {
 const value = /** @type {{name?:string,$metadata?:{httpStatusCode?:number}}|null} */ (e);
 return value?.$metadata?.httpStatusCode === 404 || ["NoSuchKey", "NotFound"].includes(value?.name || "");
}

module.exports = { PlaybackArtifactsService };
