"use strict";

const { BSON, MongoOperationTimeoutError, MongoServerError } = require("mongodb");
const MAX_BSON_BYTES = 65_536;
const PRIVATE_SEARCH_COMMENT = "sc2tools-private-search-v2";
const READER_CODES = new Set(["private_search_invalid_data", "private_search_deadline", "private_search_retired"]);

/** @param {string} code */
const readError = code => Object.assign(new Error(code), { code, status: 503 });

/** Inspect the original driver BSON document before deserializing it. These
 * are document bytes, not compressed/network transport bytes.
 * @param {unknown} raw */
function decodeRawFacet(raw) {
  if (!(raw instanceof Uint8Array) || raw.byteLength < 5 || raw.byteLength > MAX_BSON_BYTES) {
    throw readError("private_search_invalid_data");
  }
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (bytes.readInt32LE(0) !== bytes.length || bytes[bytes.length - 1] !== 0) {
    throw readError("private_search_invalid_data");
  }
  try { return { envelope: BSON.deserialize(bytes), rawBsonBytes: bytes.length }; }
  catch { throw readError("private_search_invalid_data"); }
}

/** @param {unknown} error @param {unknown} code */
function missingHint(error, code) {
  // Mongo7 reports an absent aggregate hint as BadValue2. Recognize only
  // that observed driver error; never forward its query-bearing message.
  return error instanceof MongoServerError && code === 2 && error.codeName === "BadValue"
    && error.message.endsWith("hint provided does not correspond to an existing index");
}

/** @param {unknown} error */
function safeReadError(error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === 50 || error instanceof MongoOperationTimeoutError) return readError("private_search_deadline");
  if (code === 27 || missingHint(error, code)) return readError("private_search_missing_access_path");
  if (typeof code === "string" && READER_CODES.has(code)) return readError(code);
  return readError("private_search_unavailable");
}

/** One unmodified facet BSON document, followed by actual cursor exhaustion.
 * Abort never publishes a partial buffer. Permit owners must await this
 * worker's read/close settlement even after their response deadline.
 * @param {import('mongodb').Collection<any>} collection
 * @param {{pipeline:import('mongodb').Document[],options:import('mongodb').AggregateOptions}} shape
 * @param {AbortSignal} signal @param {()=>void} check */
async function readPrivateFacet(collection, shape, signal, check) {
  const assertCurrent = () => {
    check();
    if (signal.aborted) throw readError("private_search_retired");
  };
  assertCurrent();
  // The installed driver supports cursorLifetime at runtime; its aggregate
  // public interface omits the cursor-only option. Keep that extension explicit.
  /** @type {import('mongodb').AggregateOptions & {timeoutMode:'cursorLifetime'}} */
  const options = { ...shape.options,
    raw: true, maxTimeMS: 300, timeoutMS: 300, timeoutMode: "cursorLifetime",
    allowDiskUse: false, batchSize: 1,
    readPreference: "primary", collation: { locale: "simple" }, comment: PRIVATE_SEARCH_COMMENT };
  const cursor = collection.aggregate(shape.pipeline, options);
  /** @type {Promise<void>|undefined} */ let closing;
  let closed = false;
  cursor.once("close", () => { closed = true; });
  const close = () => { if (!closing) closing = cursor.close(); return closing; };
  const abort = () => { void close().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    assertCurrent();
    const raw = await cursor.next(); assertCurrent();
    const value = decodeRawFacet(raw);
    const extra = await cursor.next(); assertCurrent();
    if (extra !== null) throw readError("private_search_invalid_data");
    return { envelopes: [value.envelope], rawBsonBytes: value.rawBsonBytes };
  } catch (error) { throw safeReadError(error); }
  finally {
    signal.removeEventListener("abort", abort);
    try { await close(); }
    catch { throw readError("private_search_cleanup_failed"); }
    if (!closed) throw readError("private_search_cleanup_failed");
  }
}

module.exports = { readPrivateFacet, decodeRawFacet, MAX_BSON_BYTES, PRIVATE_SEARCH_COMMENT };
