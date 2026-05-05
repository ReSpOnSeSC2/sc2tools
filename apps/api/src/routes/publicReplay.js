"use strict";

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const rateLimit = require("express-rate-limit");
const {
  runPythonNdjson,
  pythonAvailable,
  PythonError,
} = require("../util/pythonRunner");

/**
 * /v1/public/preview-replay — public, unauth'd, rate-limited replay
 * preview used by the marketing landing demo.
 *
 * The visitor uploads a single .SC2Replay binary as the request body
 * (Content-Type: application/octet-stream). We write it to a temp file,
 * spawn `scripts/preview_replay_cli.py`, return the parsed JSON, and
 * delete the temp file. No auth, no DB writes, no persistence.
 *
 * Limits:
 *   - body size capped at PREVIEW_MAX_BYTES (5 MB — comfortably bigger
 *     than any real replay; refuses non-replay payloads quickly)
 *   - rate-limited to PREVIEW_RATE_LIMIT_PER_MIN per IP per minute so
 *     the route can't be used to DOS the Python pool
 *   - Python timeout enforced inside runPythonNdjson (default 30s)
 *
 * @param {{ logger?: import('pino').Logger }} deps
 */
function buildPublicReplayRouter(deps = {}) {
  const router = express.Router();

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: PREVIEW_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: "rate_limited", message: "rate_limited" } },
  });

  router.post(
    "/public/preview-replay",
    limiter,
    express.raw({
      type: "application/octet-stream",
      limit: PREVIEW_MAX_BYTES,
    }),
    async (req, res, next) => {
      let tmpPath;
      try {
        if (!pythonAvailable()) {
          res
            .status(503)
            .json({ error: { code: "preview_unavailable" } });
          return;
        }
        const body = /** @type {Buffer | undefined} */ (req.body);
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res
            .status(400)
            .json({ error: { code: "empty_body" } });
          return;
        }
        if (!looksLikeMpqHeader(body)) {
          res
            .status(400)
            .json({ error: { code: "not_a_replay" } });
          return;
        }
        tmpPath = await writeTempReplay(body);
        const records = await runPythonNdjson({
          script: "scripts/preview_replay_cli.py",
          args: ["--file", tmpPath],
          timeoutMs: PREVIEW_TIMEOUT_MS,
        });
        const result = records.find((r) => r && typeof r === "object");
        if (!result) {
          res
            .status(502)
            .json({ error: { code: "parser_no_output" } });
          return;
        }
        if (result.ok === false) {
          // The CLI emits a structured failure with code + message —
          // forward both so the client can render a friendly hint.
          res.status(422).json({
            error: {
              code: String(result.code || "parse_failed"),
              message: String(result.message || ""),
            },
          });
          return;
        }
        res.json(result);
      } catch (err) {
        if (err instanceof PythonError) {
          if (deps.logger) {
            deps.logger.warn({ err }, "preview_replay_python_error");
          }
          res
            .status(502)
            .json({ error: { code: "python_error", message: err.message } });
          return;
        }
        next(err);
      } finally {
        if (tmpPath) {
          fs.promises.unlink(tmpPath).catch(() => undefined);
        }
      }
    },
  );

  return router;
}

const PREVIEW_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — way bigger than any real replay
const PREVIEW_RATE_LIMIT_PER_MIN = 6;
const PREVIEW_TIMEOUT_MS = 30 * 1000;
// SC2 replays begin with the MPQ User Data Header ("MPQ\x1b"). The
// `\x1a` variant is the inner Archive Header — it lives somewhere
// inside the file at the offset specified by the user-data preamble,
// never at byte 0 in a real replay. Accept both so a stripped MPQ
// archive (rare, mostly synthetic test fixtures) still parses, but
// the canonical SC2Replay magic is `\x1b`.
const MPQ_MAGIC_USER_DATA = Buffer.from([0x4d, 0x50, 0x51, 0x1b]);
const MPQ_MAGIC_ARCHIVE = Buffer.from([0x4d, 0x50, 0x51, 0x1a]);

/**
 * SC2 replay files are MPQ archives wrapped in a user-data preamble —
 * the first four bytes are "MPQ\x1b". A bare MPQ archive ("MPQ\x1a")
 * is also accepted for test fixtures and tooling that has stripped
 * the user-data preamble. Reject anything else so we don't waste a
 * Python spawn on a JPG or random text.
 *
 * @param {Buffer} body
 * @returns {boolean}
 */
function looksLikeMpqHeader(body) {
  if (body.length < 4) return false;
  const head = body.subarray(0, 4);
  return head.equals(MPQ_MAGIC_USER_DATA) || head.equals(MPQ_MAGIC_ARCHIVE);
}

/**
 * @param {Buffer} body
 * @returns {Promise<string>}
 */
async function writeTempReplay(body) {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "sc2tools-preview-"),
  );
  const file = path.join(dir, "upload.SC2Replay");
  await fs.promises.writeFile(file, body);
  return file;
}

module.exports = { buildPublicReplayRouter };
