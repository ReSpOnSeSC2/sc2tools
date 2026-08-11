"use strict";

const express = require("express");
const { LIMITS } = require("../config/constants");

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MD5_BASE64 = /^[A-Za-z0-9+/]{22}==$/;
const UPLOAD_ID = /^[A-Za-z0-9_-]{20,64}$/;

/**
 * Signed direct-to-R2 original replay upload/download endpoints.
 *
 * @param {{
 *   replayFiles: import('../services/replayFiles').ReplayFilesService|null,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildReplayFilesRouter(deps) {
  const router = express.Router();

  router.post(
    "/games/:gameId/replay-upload",
    deps.auth,
    async (req, res, next) => {
      try {
        const auth = requireAuth(req);
        requireDevice(auth);
        const replayFiles = requireStore(deps.replayFiles);
        const gameId = parseGameId(req.params.gameId);
        const file = parseUploadRequest(req.body);
        res.set("cache-control", "private, no-store");
        res.json(await replayFiles.prepareUpload(auth.userId, gameId, file));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/games/:gameId/replay-upload/complete",
    deps.auth,
    async (req, res, next) => {
      try {
        const auth = requireAuth(req);
        requireDevice(auth);
        const replayFiles = requireStore(deps.replayFiles);
        const gameId = parseGameId(req.params.gameId);
        const uploadId = parseUploadId(req.body);
        const replay = await replayFiles.completeUpload(
          auth.userId,
          gameId,
          uploadId,
        );
        res.set("cache-control", "private, no-store");
        res.json({
          ok: true,
          replayAvailable: true,
          replay: serializeMarker(replay),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/games/:gameId/replay-download",
    deps.auth,
    async (req, res, next) => {
      try {
        const auth = requireAuth(req);
        const replayFiles = requireStore(deps.replayFiles);
        const gameId = parseGameId(req.params.gameId);
        res.set("cache-control", "private, no-store");
        res.json(await replayFiles.prepareDownload(auth.userId, gameId));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

/** @param {unknown} raw */
function parseUploadRequest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw httpError(400, "invalid_replay_upload");
  }
  const body = /** @type {Record<string, unknown>} */ (raw);
  const filename = typeof body.filename === "string" ? body.filename.trim() : "";
  const sizeBytes = body.sizeBytes;
  const sha256 = typeof body.sha256 === "string"
    ? body.sha256.trim().toLowerCase()
    : "";
  const md5 = typeof body.md5 === "string" ? body.md5.trim() : "";
  if (
    !filename
    || filename.length > 255
    || /[\\/\u0000-\u001f\u007f]/.test(filename)
    || !/\.sc2replay$/i.test(filename)
    || !Number.isSafeInteger(sizeBytes)
    || Number(sizeBytes) < 4
    || Number(sizeBytes) > LIMITS.REPLAY_FILE_MAX_BYTES
    || !SHA256_HEX.test(sha256)
    || !MD5_BASE64.test(md5)
    || Buffer.from(md5, "base64").length !== 16
  ) {
    throw httpError(400, "invalid_replay_upload");
  }
  return { filename, sizeBytes: Number(sizeBytes), sha256, md5 };
}

/** @param {unknown} raw */
function parseGameId(raw) {
  const gameId = String(raw || "").trim();
  if (!gameId || gameId.length > 200) {
    throw httpError(400, "invalid_game_id");
  }
  return gameId;
}

/** @param {unknown} raw */
function parseUploadId(raw) {
  const body = raw && typeof raw === "object" && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  const uploadId = typeof body.uploadId === "string"
    ? body.uploadId.trim()
    : "";
  if (!UPLOAD_ID.test(uploadId)) {
    throw httpError(400, "invalid_replay_upload_id");
  }
  return uploadId;
}

/** @param {import('express').Request} req */
function requireAuth(req) {
  if (!req.auth || !req.auth.userId) throw httpError(401, "auth_required");
  return req.auth;
}

/** @param {{source?: string}} auth */
function requireDevice(auth) {
  if (auth.source !== "device") throw httpError(403, "device_auth_required");
}

/** @param {any} replayFiles */
function requireStore(replayFiles) {
  if (!replayFiles) throw httpError(503, "replay_storage_unavailable");
  return replayFiles;
}

/** @param {Record<string, any>} marker */
function serializeMarker(marker) {
  return {
    sizeBytes: marker.sizeBytes,
    sha256: marker.sha256,
    storedAt: marker.storedAt instanceof Date
      ? marker.storedAt.toISOString()
      : marker.storedAt,
  };
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
  buildReplayFilesRouter,
  _internals: { parseUploadRequest, parseGameId, parseUploadId },
};
