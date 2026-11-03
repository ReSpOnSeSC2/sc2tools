"use strict";

const { LIMITS } = require("../config/constants");

const MAX_GAMES = 100;
const MAX_GAME_ID = 200;
const MAX_URL = 4096;
const MAX_FILENAME = 255;
const MAX_ROW_BYTES = 8 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const DOWNLOAD_SECONDS = 60;
const MARKER_FIELDS = Object.freeze(["version", "uploadId", "sizeBytes", "sha256", "md5", "storedAt"]);
const NUMBER_TYPES = new Set(["int", "long", "double"]);
const SHA256 = /^[0-9a-f]{64}$/;
const MD5 = /^[A-Za-z0-9+/]{22}==$/;
const UPLOAD_ID = /^[A-Za-z0-9_-]{20,64}$/;

/** @param {string} value */
function validUnicode(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Validate the raw count and primitives before normalization, deduplication or IO.
 * @param {unknown} raw @returns {ReadonlyArray<string>}
 */
function parseDownloadBatch(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalidRequest();
  const keys = Reflect.ownKeys(raw);
  const field = Object.getOwnPropertyDescriptor(raw, "gameIds");
  if (keys.length !== 1 || keys[0] !== "gameIds" || !field || !("value" in field)) throw invalidRequest();
  const input = field.value;
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_GAMES) throw invalidRequest();
  const ids = [], seen = new Set();
  for (const item of input) {
    if (typeof item !== "string" || !item || item.length > MAX_GAME_ID
      || /[\u0000-\u001f\u007f-\u009f]/u.test(item) || !validUnicode(item)) throw invalidRequest();
    const id = item.trim();
    if (!id || /^[a-z][a-z0-9+.-]*:/iu.test(id) || /^[/\\]{2}/u.test(id) || seen.has(id)) throw invalidRequest();
    seen.add(id); ids.push(id);
  }
  return Object.freeze(ids);
}

/** @returns {Error & {status:number, code:string}} */
function invalidRequest() {
  return Object.assign(new Error("invalid_replay_download_batch"), { status: 400, code: "invalid_replay_download_batch" });
}

/** Keep only bounded known fields, with their actual BSON types from the initial projection.
 * @param {Record<string, any>} game
 * @returns {{values: Record<string, any>, predicate: Record<string, any>}|null}
 */
function captureMarker(game) {
  const marker = game.replayFile;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
  /** @type {Record<string, any>} */ const values = {};
  /** @type {Record<string, any>[]} */ const clauses = [];
  for (const field of MARKER_FIELDS) {
    const present = Object.hasOwn(marker, field), type = game[`__packType_${field}`];
    if (!present) {
      if (type !== "missing" || ["sizeBytes", "sha256", "storedAt"].includes(field)) return null;
      clauses.push({ [`replayFile.${field}`]: { $exists: false } });
      continue;
    }
    const value = marker[field];
    if (!validMarkerField(field, value, type)) return null;
    values[field] = value instanceof Date ? new Date(value.getTime()) : value;
    // Query $type alone can match an array element. Expression $type proves the field's own BSON type.
    clauses.push({ [`replayFile.${field}`]: { $eq: values[field] } },
      { $expr: { $eq: [{ $type: `$replayFile.${field}` }, type] } });
  }
  return { values: Object.freeze(values), predicate: { $and: clauses } };
}

/** @param {string} field @param {any} value @param {unknown} type */
function validMarkerField(field, value, type) {
  if (field === "version") return NUMBER_TYPES.has(String(type)) && value === 1;
  if (field === "sizeBytes") return NUMBER_TYPES.has(String(type)) && Number.isSafeInteger(value)
    && value >= 4 && value <= LIMITS.REPLAY_FILE_MAX_BYTES;
  if (field === "storedAt") return (type === "date" && value instanceof Date && Number.isFinite(value.getTime()))
    || (type === "string" && typeof value === "string" && value.length > 0 && value.length <= 64 && Number.isFinite(Date.parse(value)));
  if (type !== "string" || typeof value !== "string") return false;
  if (field === "sha256") return SHA256.test(value);
  if (field === "uploadId") return UPLOAD_ID.test(value);
  return field === "md5" && MD5.test(value) && Buffer.from(value, "base64").toString("base64") === value;
}

/** @returns {Record<string, any>} */
function packProjection() {
  /** @type {Record<string, any>} */ const projection = { _id: 0, gameId: 1, date: 1, map: 1, "opponent.displayName": 1 };
  for (const field of MARKER_FIELDS) {
    projection[`replayFile.${field}`] = 1;
    projection[`__packType_${field}`] = { $type: `$replayFile.${field}` };
  }
  return projection;
}

/** @typedef {{gameId:string, status:'unavailable'|'retryable', code:string}} FailedRow */
/** @param {string} gameId @param {boolean} [retryable] @param {boolean} [expired] @returns {FailedRow} */
function failedRow(gameId, retryable = false, expired = false) {
  return { gameId, status: retryable ? "retryable" : "unavailable",
    code: expired ? "replay_download_expired" : retryable ? "replay_download_unavailable" : "replay_unavailable" };
}

/** @param {unknown} url @param {unknown} filename */
function safeDownloadFields(url, filename) {
  if (typeof url !== "string" || !url || url.length > MAX_URL || /[\u0000-\u0020\u007f]/u.test(url) || !validUnicode(url)
    || typeof filename !== "string" || !filename || filename.length > MAX_FILENAME
    || /[\\/\u0000-\u001f\u007f]/u.test(filename) || !validUnicode(filename)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash;
  } catch { return false; }
}

/** @param {Record<string, any>} row */
function boundedRow(row) {
  return Buffer.byteLength(JSON.stringify(row), "utf8") <= MAX_ROW_BYTES;
}

module.exports = { MAX_GAMES, MAX_GAME_ID, MAX_URL, MAX_FILENAME, MAX_ROW_BYTES, MAX_BODY_BYTES,
  DOWNLOAD_SECONDS, parseDownloadBatch, captureMarker, packProjection, failedRow, safeDownloadFields, boundedRow, validUnicode };
