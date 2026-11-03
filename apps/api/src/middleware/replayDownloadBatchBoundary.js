"use strict";

const BATCH_PATH = /^\/v1\/replays\/download-batch\/?$/i;
const BODY_BYTES = 256 * 1024;
const REPLAY_DOWNLOAD_COMMENT = "sc2tools-replay-download-batch-v1";
const PRIVATE_FAILURE = Symbol("replayDownloadBatchFailure");
/** @type {Readonly<Record<string,number>>} */
const CODES = Object.freeze({ invalid_replay_download_batch: 400, replay_download_body_too_large: 413,
  replay_download_unsupported_media_type: 415, replay_download_unavailable: 503, replay_storage_unavailable: 503,
  export_busy: 503, auth_required: 401, missing_token: 401, invalid_token: 401, auth_failed: 401,
  account_deleted: 401, gdpr_operation_busy: 409 });
/** @type {Readonly<Record<string,string>>} */
const PARSER_CODES = Object.freeze({ "entity.parse.failed": "invalid_replay_download_batch",
  "entity.too.large": "replay_download_body_too_large", "request.aborted": "invalid_replay_download_batch",
  "request.size.invalid": "invalid_replay_download_batch", "encoding.unsupported": "replay_download_unsupported_media_type",
  "charset.unsupported": "replay_download_unsupported_media_type" });

/** Exact Express-equivalent case/trailing-slash matcher, without URL dot-segment rewriting.
 * @param {unknown} value
 */
function isReplayDownloadBatchPath(value) {
  if (typeof value !== "string") return false;
  return BATCH_PATH.test(value.split(/[?#]/u, 1)[0].replace(/^https?:\/\/[^/]+(?=\/)/i, ""));
}

/** This read performs no general user-data mutation lease.
 * @param {{method?:unknown,originalUrl?:unknown,url?:unknown}} req
 */
function isReplayDownloadBatchPost(req) {
  return req.method === "POST" && isReplayDownloadBatchPath(req.originalUrl || req.url);
}

/** @type {import('express').RequestHandler} */
const replayDownloadBatchNoStore = (req, res, next) => {
  if (isReplayDownloadBatchPath(req.originalUrl || req.url)) res.setHeader("Cache-Control", "private, no-store");
  next();
};

/** New fixed Error only: never retain parser body, raw message/cause or authentication details.
 * @param {unknown} error @returns {Error & {status:number,code:string}}
 */
function safeReplayDownloadBatchError(error) {
  /** @type {PropertyDescriptorMap} */ let fields = {};
  try { if (error && typeof error === "object") fields = Object.getOwnPropertyDescriptors(error); } catch { /* Unreadable failures get the fixed default. */ }
  const type = fields.type?.value, rawCode = fields.code?.value;
  const code = typeof type === "string" && Object.hasOwn(PARSER_CODES, type) ? PARSER_CODES[type]
    : typeof rawCode === "string" && Object.hasOwn(CODES, rawCode) ? rawCode : "replay_download_unavailable";
  const safe = Object.assign(new Error(code), { status: CODES[code], code });
  Object.defineProperty(safe, PRIVATE_FAILURE, { value: true });
  return safe;
}

/** @param {unknown} error */
function isReplayDownloadBatchFailure(error) {
  if (!error || typeof error !== "object") return false;
  try { return Object.getOwnPropertyDescriptor(error, PRIVATE_FAILURE)?.value === true; } catch { return false; }
}

/** Parse before the ordinary parser and replace its failures before they can reach logging/SDK handlers. */
function buildReplayDownloadBatchJsonParser() {
  const parser = require("express").json({ limit: BODY_BYTES, strict: true });
  /** @type {import('express').RequestHandler} */
  const handler = (req, res, next) => {
    if (!isReplayDownloadBatchPost(req)) { next(); return; }
    parser(req, res, error => next(error ? safeReplayDownloadBatchError(error) : undefined));
  };
  return handler;
}

/** @type {import('express').ErrorRequestHandler} */
const replayDownloadBatchErrorBoundary = (error, req, res, next) => {
  if (!isReplayDownloadBatchPath(req.originalUrl || req.url)) { next(error); return; }
  res.setHeader("Cache-Control", "private, no-store");
  const safe = safeReplayDownloadBatchError(error);
  if (res.headersSent) { next(safe); return; }
  res.status(safe.status).json({ error: { code: safe.code } });
};

module.exports = { BODY_BYTES, REPLAY_DOWNLOAD_COMMENT, isReplayDownloadBatchPath, isReplayDownloadBatchPost, isReplayDownloadBatchFailure, replayDownloadBatchNoStore,
  safeReplayDownloadBatchError, buildReplayDownloadBatchJsonParser, replayDownloadBatchErrorBoundary };
