"use strict";

const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { createGzip, createGunzip } = require("zlib");
const { createInterface } = require("readline");
const {
  S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const PART_BYTES = 8 * 1024 * 1024;
const LINE_MAX_BYTES = 24 * 1024 * 1024;

/** Private gzip NDJSON objects. Multipart uploads bound memory without a whole
 * export buffer, a temporary disk requirement, or another storage dependency. */
class UserBackupsStore {
  /** @param {{client: import('@aws-sdk/client-s3').S3Client, bucket: string, signer?: typeof getSignedUrl}} opts */
  constructor(opts) { this.client = opts.client; this.bucket = opts.bucket; this.signer = opts.signer || getSignedUrl; }

  /** @param {string} userId @param {string} id */
  keyFor(userId, id) {
    if (!userId || !/^bk_[A-Za-z0-9_-]{1,90}$/.test(id)) throw new Error("invalid_backup_identity");
    return `${this.prefixFor(userId)}${encodeURIComponent(id)}.ndjson.gz`;
  }
  /** @param {string} userId */
  prefixFor(userId) { if (!userId) throw new Error("backup_owner_required"); return `user-backups/${encodeURIComponent(userId)}/`; }

  /** @param {string} userId @param {string} id @param {AsyncIterable<string>} lines */
  async put(userId, id, lines) {
    const Key = this.keyFor(userId, id); const Bucket = this.bucket;
    const upload = await this.client.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType: "application/gzip", Metadata: { format: "ndjson-gzip-v1" } }));
    if (!upload.UploadId) throw new Error("backup_upload_not_started");
    const UploadId = upload.UploadId; const input = Readable.from(lines); const gzip = createGzip();
    let compressionError; const compression = pipeline(input, gzip).catch((error) => { compressionError = error; gzip.destroy(error); });
    /** @type {import('@aws-sdk/client-s3').CompletedPart[]} */
    const parts = []; let sizeBytes = 0; let pendingBytes = 0;
    /** @type {Buffer[]} */
    let pending = [];
    const send = async () => {
      if (parts.length >= 10000) throw new Error("backup_multipart_limit");
      const Body = Buffer.concat(pending, pendingBytes); const PartNumber = parts.length + 1;
      const sent = await this.client.send(new UploadPartCommand({ Bucket, Key, UploadId, PartNumber, Body, ContentLength: Body.length }));
      if (!sent.ETag) throw new Error("backup_part_not_confirmed");
      parts.push({ ETag: sent.ETag, PartNumber }); sizeBytes += Body.length; pending = []; pendingBytes = 0;
    };
    try {
      for await (const raw of gzip) {
        let chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        while (chunk.length) {
          const take = Math.min(PART_BYTES - pendingBytes, chunk.length);
          pending.push(chunk.subarray(0, take)); pendingBytes += take; chunk = chunk.subarray(take);
          if (pendingBytes === PART_BYTES) await send();
        }
      }
      await compression; if (compressionError) throw compressionError;
      if (pendingBytes) await send();
      await this.client.send(new CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: parts } }));
      return { sizeBytes };
    } catch (error) {
      input.destroy(); gzip.destroy();
      try { await this.client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId })); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally { input.destroy(); gzip.destroy(); await compression; }
  }

  /** @param {string} userId @param {string} id */
  async *read(userId, id) {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.keyFor(userId, id) }));
    if (!response.Body) throw new Error("backup_body_missing");
    const input = Readable.from(/** @type {AsyncIterable<Buffer>} */ (response.Body)); const gunzip = createGunzip();
    let decompressionError; const decompression = pipeline(input, gunzip).catch((error) => { decompressionError = error; gunzip.destroy(error); });
    const reader = createInterface({ input: gunzip, crlfDelay: Infinity });
    try {
      for await (const line of reader) { if (Buffer.byteLength(line) > LINE_MAX_BYTES) throw new Error("backup_record_too_large"); yield line; }
      await decompression; if (decompressionError) throw decompressionError;
    } finally { reader.close(); input.destroy(); gunzip.destroy(); await decompression; }
  }

  /** @param {string} userId @param {string} id */
  async download(userId, id) {
    return { url: await this.signer(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: this.keyFor(userId, id), ResponseContentType: "application/gzip",
      ResponseContentDisposition: `attachment; filename="sc2tools-${id}.ndjson.gz"`, ResponseCacheControl: "private, no-store" }), { expiresIn: 60 }), expiresIn: 60 };
  }
  /** @param {string} userId @param {string} id */
  async delete(userId, id) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.keyFor(userId, id) })); }

  /** Also covers an interrupted upload's completed object before metadata insertion. @param {string} userId */
  async deleteAllForUser(userId) {
    /** @type {string|undefined} */
    let ContinuationToken;
    do {
      /** @type {import('@aws-sdk/client-s3').ListObjectsV2CommandOutput} */
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.prefixFor(userId), ContinuationToken }));
      const Objects = (page.Contents || []).filter((item) => item.Key).map((item) => ({ Key: item.Key }));
      if (Objects.length) {
        const removed = await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects } }));
        if (removed.Errors?.length) throw new Error("backup_object_delete_failed");
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
  }
}

/** @param {{r2?: {endpoint?:string,bucket?:string,region?:string,accessKeyId?:string,secretAccessKey?:string}|null}} config */
function buildUserBackupsStore(config) {
  const r2 = config.r2;
  if (!r2?.endpoint || !r2.bucket || !r2.accessKeyId || !r2.secretAccessKey) return null;
  const client = new S3Client({ region: r2.region || "auto", endpoint: r2.endpoint, forcePathStyle: true, credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey } });
  return new UserBackupsStore({ client, bucket: r2.bucket });
}
module.exports = { UserBackupsStore, buildUserBackupsStore, PART_BYTES };
