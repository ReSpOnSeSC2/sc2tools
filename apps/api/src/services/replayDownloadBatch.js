"use strict";

const { GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { LIVE_GAME_MATCH } = require("../util/gameVisibility");
const { REPLAY_DOWNLOAD_COMMENT } = require("../middleware/replayDownloadBatchBoundary");
const { DOWNLOAD_SECONDS, MAX_BODY_BYTES, parseDownloadBatch, captureMarker, packProjection,
  failedRow, safeDownloadFields, boundedRow } = require("./replayDownloadBatchPolicy");

const CONCURRENCY = 4;
const DB_MAX_TIME_MS = 5000;
/** @typedef {import('./replayFiles').ReplayFilesService} Store */
/** @typedef {{filenameFor:(game:Record<string, any>)=>string, disposition:(name:string)=>string}} Naming */
/** @typedef {{gameId:string,status:'available',url:string,filename:string,sizeBytes:number,issuedAt:string,expiresAt:string}} AvailableRow */
/** @typedef {AvailableRow|import('./replayDownloadBatchPolicy').FailedRow} Row */

/** No read/signing queue survives this finite call. Cancellation joins every admitted real promise.
 * @param {Store} store @param {string} owner @param {ReadonlyArray<string>} gameIds
 * @param {{signal?:AbortSignal, now?:()=>number}} options @param {Naming} naming
 */
async function prepareReplayDownloadBatch(store, owner, gameIds, options, naming) {
  const ids = parseDownloadBatch({ gameIds });
  if (typeof owner !== "string" || !owner || owner.length > 200) throw new Error("invalid_replay_download_owner");
  const signal = options.signal || new AbortController().signal, now = options.now || Date.now;
  signal.throwIfAborted();
  /** @type {Row[]} */ const rows = new Array(ids.length);
  let next = 0;
  const worker = async () => {
    while (!signal.aborted) {
      const index = next++;
      if (index >= ids.length) return;
      try { rows[index] = await prepareOne(store, owner, ids[index], signal, now, naming); }
      catch { signal.throwIfAborted(); rows[index] = failedRow(ids[index], true); }
    }
    signal.throwIfAborted();
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  signal.throwIfAborted();
  if (settled.some(result => result.status === "rejected")) throw new Error("replay_download_unavailable");
  const items = rows.map(row => row.status === "available" && now() >= Date.parse(row.expiresAt)
    ? failedRow(row.gameId, true, true) : row);
  const counts = { requested: ids.length, available: 0, unavailable: 0, retryable: 0 };
  for (const row of items) counts[row.status] += 1;
  const result = { format: "sc2tools-replay-download-batch", version: 1, items, counts };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_BODY_BYTES) throw new Error("replay_download_unavailable");
  return result;
}

/** @param {string} owner @param {string} gameId @param {Record<string,any>} [identity] */
function ownedFilter(owner, gameId, identity = {}) {
  return { userId: owner, gameId, ...LIVE_GAME_MATCH, isResumedFromReplay: { $ne: true }, ...identity };
}

/** @param {Store} store @param {string} owner @param {string} gameId @param {AbortSignal} signal
 * @param {()=>number} now @param {Naming} naming @returns {Promise<Row>}
 */
async function prepareOne(store, owner, gameId, signal, now, naming) {
  signal.throwIfAborted();
  const game = await store.games.findOne(ownedFilter(owner, gameId), { projection: packProjection(), signal, maxTimeMS: DB_MAX_TIME_MS, comment: REPLAY_DOWNLOAD_COMMENT });
  signal.throwIfAborted();
  const marker = game && captureMarker(game);
  if (!marker) return failedRow(gameId);
  const identity = ownedFilter(owner, gameId, marker.predicate), key = store.keyFor(owner, gameId);
  const matches = await headMatches(store, key, marker.values, signal);
  signal.throwIfAborted();
  if (!matches) {
    // This pinned Mongo driver supports AbortSignal on cursor reads, not UpdateOptions.
    // The bounded CAS is non-cancellable and remains actually awaited before lease release.
    await store.games.updateOne(identity, { $unset: { replayFile: "" } }, { maxTimeMS: DB_MAX_TIME_MS, comment: REPLAY_DOWNLOAD_COMMENT });
    signal.throwIfAborted();
    return failedRow(gameId);
  }
  const filename = naming.filenameFor(game);
  const issued = Math.floor(now() / 1000) * 1000, expires = issued + DOWNLOAD_SECONDS * 1000;
  const command = new GetObjectCommand({ Bucket: store.bucket, Key: key, ResponseContentType: "application/octet-stream",
    ResponseContentDisposition: naming.disposition(filename) });
  // Credential resolution/signing may ignore cancellation. Await its actual settlement before returning.
  const url = await store.signer(store.client, command, { expiresIn: DOWNLOAD_SECONDS, signingDate: new Date(issued) });
  signal.throwIfAborted();
  if (now() >= expires) return failedRow(gameId, true, true);
  if (!safeDownloadFields(url, filename)) return failedRow(gameId, true);
  const current = await store.games.findOne(identity, { projection: { _id: 1 }, signal, maxTimeMS: DB_MAX_TIME_MS, comment: REPLAY_DOWNLOAD_COMMENT });
  signal.throwIfAborted();
  if (!current) return failedRow(gameId);
  if (now() >= expires) return failedRow(gameId, true, true);
  /** @type {AvailableRow} */ const row = { gameId, status: "available", url, filename, sizeBytes: marker.values.sizeBytes,
    issuedAt: new Date(issued).toISOString(), expiresAt: new Date(expires).toISOString() };
  return boundedRow(row) ? row : failedRow(gameId, true);
}

/** Only a genuinely missing object or a verified content mismatch permits stale-marker cleanup.
 * @param {Store} store @param {string} key @param {Record<string,any>} marker @param {AbortSignal} signal
 */
async function headMatches(store, key, marker, signal) {
  let head;
  try { head = await store.client.send(new HeadObjectCommand({ Bucket: store.bucket, Key: key }), { abortSignal: signal }); }
  catch (error) {
    signal.throwIfAborted();
    const failure = /** @type {{name?:unknown,Code?:unknown,$metadata?:{httpStatusCode?:unknown}}} */ (error || {});
    const status = failure.$metadata?.httpStatusCode;
    const codes = [failure.name, failure.Code];
    if (status === 401 || status === 403 || codes.some(code => code === "AccessDenied" || code === "Forbidden" || code === "Unauthorized")) {
      throw new Error("replay_download_unavailable");
    }
    if (codes.some(code => code === "NoSuchKey" || code === "NotFound") && (status === undefined || status === 404)) return false;
    throw new Error("replay_download_unavailable");
  }
  signal.throwIfAborted();
  if (!Number.isSafeInteger(head.ContentLength) || Number(head.ContentLength) < 0) throw new Error("replay_download_unavailable");
  const metadata = head.Metadata;
  if (metadata === undefined) return false;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(metadata))) throw new Error("replay_download_unavailable");
  const field = Object.getOwnPropertyDescriptor(metadata, "sha256");
  if (!field) return false;
  if (!("value" in field) || typeof field.value !== "string") throw new Error("replay_download_unavailable");
  return head.ContentLength === marker.sizeBytes && field.value.toLowerCase() === marker.sha256;
}

module.exports = { prepareReplayDownloadBatch, CONCURRENCY, DB_MAX_TIME_MS };
