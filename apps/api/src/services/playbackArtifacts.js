"use strict";

const { createHash } = require("crypto");
const { PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { validateManifest, validateSegment, MAX_SEGMENT_BYTES, MAX_MANIFEST_BYTES, SHA } = require("../validation/playbackArtifact");
/** @param {Buffer} body */
const digest = (body) => createHash("sha256").update(body).digest("hex");
/** @param {number} status @param {string} code */
const error = (status, code) => Object.assign(new Error(code), { status, code });

class PlaybackArtifactsService {
  /** @param {{client: import('@aws-sdk/client-s3').S3Client, bucket: string, games: import('mongodb').Collection}} options */
  constructor({ client, bucket, games }) {
    this.client = client;
    this.bucket = bucket;
    this.games = games;
    this.activeReads = 0;
    this.activeWrites = 0;
  }

  /** @param {string} userId @param {string} [gameId] */
  prefix(userId, gameId) {
    return `mapped-playback/v1/${encodeURIComponent(userId)}/${gameId == null ? "" : `${encodeURIComponent(gameId)}/`}`;
  }

  /** @param {string} userId @param {string} gameId @param {string} artifactId @param {string} file */
  key(userId, gameId, artifactId, file) {
    if (!SHA.test(artifactId)) throw error(400, "invalid_artifact_id");
    return `${this.prefix(userId, gameId)}${artifactId}/${file}`;
  }

  /** @param {string} userId @param {string} gameId */
  async owned(userId, gameId) {
    const game = await this.games.findOne({ userId, gameId }, { projection: { replayFile: 1, playbackArtifact: 1 } });
    if (!game) throw error(404, "game_not_found");
    return game;
  }

  /** @param {string} userId @param {string} gameId @param {string} artifactId */
  async stillOwned(userId, gameId, artifactId) {
    try { return await this.owned(userId, gameId); }
    catch (cause) {
      if (/** @type {{status?:number}} */ (cause).status === 404) {
        // A GDPR purge may finish while this request's PUT is in flight.
        // Remove that late object rather than leaving an orphan generation.
        await this.deletePrefix(this.key(userId, gameId, artifactId, ""));
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

  /** @param {string} userId @param {string} gameId @param {string} artifactId */
  async manifest(userId, gameId, artifactId) {
    const body = await this.read(this.key(userId, gameId, artifactId, "manifest.json"), MAX_MANIFEST_BYTES);
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
      const reserved = await this.games.updateOne({ userId, gameId }, {
        $set: { playbackUpload: { artifactId, preparedAt: new Date() } },
      });
      if (reserved.matchedCount !== 1) throw error(404, "game_not_found");
      await this.put(this.key(userId, gameId, artifactId, "manifest.json"), body);
      await this.stillOwned(userId, gameId, artifactId);
      return { ok: true, artifactId };
    });
  }

  /** @param {string} userId @param {string} gameId @param {string} artifactId @param {number} index @param {Buffer|undefined} body */
  async upload(userId, gameId, artifactId, index, body) {
    return this.bounded("write", async () => {
      const game = await this.owned(userId, gameId);
      const m = await this.manifest(userId, gameId, artifactId);
      this.assertSource(game, m);
      const d = m.segments[index];
      if (!d || !Number.isInteger(index) || index < 0) throw error(400, "invalid_segment_index");
      if (!Buffer.isBuffer(body) || body.length > MAX_SEGMENT_BYTES || body.length !== d.sizeBytes || digest(body) !== d.sha256) throw error(400, "playback_segment_digest_mismatch");
      validateSegment(JSON.parse(body.toString("utf8")), m, d);
      await this.put(this.key(userId, gameId, artifactId, `${index}.json`), body, { sha256: d.sha256 });
      await this.stillOwned(userId, gameId, artifactId);
      return { ok: true, index, sha256: d.sha256 };
    });
  }

  /** @param {string} userId @param {string} gameId @param {string} artifactId */
  async complete(userId, gameId, artifactId) {
    return this.bounded("write", async () => {
      const game = await this.owned(userId, gameId);
      const m = await this.manifest(userId, gameId, artifactId);
      this.assertSource(game, m);
      // Only this API writes these keys after validating raw bytes; HEAD is a
      // bounded completion proof, avoiding whole-replay hydration on the API.
      for (const s of m.segments) {
        let head;
        try { head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(userId, gameId, artifactId, `${s.index}.json`) })); }
        catch (e) { if (isMissing(e)) throw error(409, "playback_segments_incomplete"); throw e; }
        if (Number(head.ContentLength) !== s.sizeBytes || head.Metadata?.sha256 !== s.sha256) throw error(409, "playback_segments_incomplete");
      }
      const marker = { artifactId, replaySha256: m.replaySha256, segmentCount: m.segments.length, storedAt: new Date() };
      const result = await this.games.updateOne({ userId, gameId, $or: [
        { "playbackUpload.artifactId": artifactId }, { "playbackArtifact.artifactId": artifactId },
      ] }, { $set: { playbackArtifact: marker }, $unset: { playbackUpload: "" } });
      if (result.matchedCount !== 1) {
        await this.stillOwned(userId, gameId, artifactId);
        throw error(409, "playback_artifact_superseded");
      }
      return { ok: true, artifactId, segmentCount: m.segments.length };
    });
  }

  /** @param {string} userId @param {string} gameId */
  async getManifest(userId, gameId) {
    return this.bounded("read", async () => {
      const game = await this.owned(userId, gameId);
      const id = game.playbackArtifact?.artifactId;
      if (!id) throw error(404, "playback_artifact_not_found");
      return { ok: true, artifactId: id, manifest: await this.manifest(userId, gameId, id) };
    });
  }

  /** @param {string} userId @param {string} gameId @param {string} artifactId @param {number} index */
  async getSegment(userId, gameId, artifactId, index) {
    return this.bounded("read", async () => {
      const game = await this.owned(userId, gameId);
      if (game.playbackArtifact?.artifactId !== artifactId) throw error(404, "playback_artifact_not_found");
      const m = await this.manifest(userId, gameId, artifactId);
      const d = m.segments[index];
      if (!d || !Number.isInteger(index) || index < 0) throw error(404, "playback_artifact_not_found");
      const body = await this.read(this.key(userId, gameId, artifactId, `${index}.json`), MAX_SEGMENT_BYTES);
      if (body.length !== d.sizeBytes || digest(body) !== d.sha256) throw error(502, "playback_artifact_corrupt");
      return body;
    });
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

  /** @param {string} userId */
  async deleteAllForUser(userId) { await this.deletePrefix(this.prefix(userId)); }
  /** @param {string} userId @param {string[]} gameIds */
  async deleteMany(userId, gameIds) { for (const gameId of gameIds) await this.deletePrefix(this.prefix(userId, gameId)); }
}

/** @param {unknown} e */
function isMissing(e) {
 const value = /** @type {{name?:string,$metadata?:{httpStatusCode?:number}}|null} */ (e);
 return value?.$metadata?.httpStatusCode === 404 || ["NoSuchKey", "NotFound"].includes(value?.name || "");
}

module.exports = { PlaybackArtifactsService };
