// @ts-nocheck
"use strict";
const { Readable } = require("stream");
const { UserBackupsStore } = require("../../src/services/userBackupsStore");

/** In-memory S3 transport: exercises the production gzip/multipart protocol. */
function createBackupStore() {
  const objects = new Map(); const uploads = new Map(); const calls = [];
  const client = { send: jest.fn(async (command) => {
    const input = command.input; const name = command.constructor.name; calls.push({ name, input });
    if (name === "CreateMultipartUploadCommand") { const UploadId = `upload-${uploads.size}`; uploads.set(UploadId, []); return { UploadId }; }
    if (name === "UploadPartCommand") { uploads.get(input.UploadId)[input.PartNumber - 1] = Buffer.from(input.Body); return { ETag: `part-${input.PartNumber}` }; }
    if (name === "CompleteMultipartUploadCommand") { objects.set(input.Key, Buffer.concat(uploads.get(input.UploadId))); uploads.delete(input.UploadId); return {}; }
    if (name === "AbortMultipartUploadCommand") { uploads.delete(input.UploadId); return {}; }
    if (name === "GetObjectCommand") { if (!objects.has(input.Key)) throw new Error("NoSuchKey"); return { Body: Readable.from([objects.get(input.Key)]) }; }
    if (name === "DeleteObjectCommand") { objects.delete(input.Key); return {}; }
    if (name === "ListObjectsV2Command") return { Contents: [...objects.keys()].filter((key) => key.startsWith(input.Prefix)).map((Key) => ({ Key })) };
    if (name === "DeleteObjectsCommand") { for (const item of input.Delete.Objects) objects.delete(item.Key); return {}; }
    throw new Error(`Unexpected ${name}`);
  }) };
  const store = new UserBackupsStore({ client, bucket: "test-backups", signer: async (_client, command) => `https://private.fixture/${command.input.Key}?signed=1` });
  return Object.assign(store, { objects, uploads, calls });
}
module.exports = { createBackupStore };
