"use strict";

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const rateLimit = require("express-rate-limit");
const {
  runPythonNdjson,
  pythonAvailable,
  resolveProjectDir,
  resolvePythonExe,
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
 * Observability:
 *   - Each pipeline step (header check, magic check, tmp write, python
 *     spawn, json parse, result classify) emits a structured pino log
 *     line with `step`, `status`, `durationMs`, `requestId`. Greppable
 *     and chartable in Render's log explorer.
 *   - The CLI emits step-marker NDJSON records (when --trace is set);
 *     these are forwarded to the same pino logger so we can see what
 *     the Python process was doing when it failed.
 *   - GET /preview-replay/health returns the chain status (analyzer
 *     dir, python exe, sc2reader version, cli runnable) so we can
 *     diagnose deployment regressions with one curl.
 *
 * @param {{ logger?: import('pino').Logger }} deps
 */
function buildPublicReplayRouter(deps = {}) {
  const router = express.Router();
  const log = deps.logger;

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: PREVIEW_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: "rate_limited", message: "rate_limited" } },
  });

  // Health-check has its own rate limit — public, but still bounded so
  // the diagnostic page can't be used to amplify a DOS.
  const healthLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: HEALTH_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: "rate_limited", message: "rate_limited" } },
  });

  router.get(
    "/public/preview-replay/health",
    healthLimiter,
    async (req, res, next) => {
      const requestId = String(req.id || res.getHeader("x-request-id") || "");
      const t0 = process.hrtime.bigint();
      try {
        const report = await collectChainHealth(req);
        if (log) {
          log.info(
            {
              route: "preview_replay_health",
              requestId,
              durationMs: hrToMs(t0),
              ...report.flat,
            },
            "preview_replay_health_report",
          );
        }
        const status = report.healthy ? 200 : 503;
        res.status(status).json(report.body);
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/public/preview-replay",
    limiter,
    express.raw({
      type: "application/octet-stream",
      limit: PREVIEW_MAX_BYTES,
    }),
    async (req, res, next) => {
      const requestId = String(req.id || res.getHeader("x-request-id") || "");
      const t0 = process.hrtime.bigint();
      let tmpPath;

      const stepLog = (step, fields = {}) => {
        if (!log) return;
        log.info(
          {
            route: "preview_replay",
            requestId,
            step,
            elapsedMs: hrToMs(t0),
            ...fields,
          },
          "preview_replay_step",
        );
      };

      try {
        // Step 1: confirm the analyzer chain is reachable on this host.
        if (!pythonAvailable()) {
          stepLog("python_unavailable", {
            status: "fail",
            analyzerDir: resolveProjectDir(),
            pythonExe: resolvePythonExe(),
          });
          res.status(503).json({
            error: { code: "preview_unavailable", requestId },
          });
          return;
        }
        stepLog("python_available_check", { status: "pass" });

        // Step 2: body size + non-empty.
        const body = /** @type {Buffer | undefined} */ (req.body);
        if (!Buffer.isBuffer(body) || body.length === 0) {
          stepLog("body_check", { status: "fail", reason: "empty_body" });
          res.status(400).json({ error: { code: "empty_body", requestId } });
          return;
        }
        stepLog("body_check", { status: "pass", bytes: body.length });

        // Step 3: MPQ magic byte signature.
        if (!looksLikeMpqHeader(body)) {
          stepLog("magic_check", {
            status: "fail",
            reason: "not_a_replay",
            firstFourHex: body.subarray(0, 4).toString("hex"),
          });
          res.status(400).json({ error: { code: "not_a_replay", requestId } });
          return;
        }
        stepLog("magic_check", { status: "pass" });

        // Step 4: write to a temp file so the Python CLI can mmap it.
        const tWrite = process.hrtime.bigint();
        tmpPath = await writeTempReplay(body);
        stepLog("tmp_write", {
          status: "pass",
          path: tmpPath,
          writeMs: hrToMs(tWrite),
        });

        // Step 5: spawn the Python CLI with --trace; runner collects
        // every NDJSON record including step-markers and the final
        // ok:true|false record.
        const tSpawn = process.hrtime.bigint();
        const records = await runPythonNdjson({
          script: "scripts/preview_replay_cli.py",
          args: ["--file", tmpPath, "--trace"],
          timeoutMs: PREVIEW_TIMEOUT_MS,
          onProgress: (rec) => {
            if (rec && rec.trace === true && log) {
              log.debug(
                {
                  route: "preview_replay",
                  requestId,
                  cliStep: rec.step,
                  cliFields: rec,
                },
                "preview_replay_cli_trace",
              );
            }
          },
        });
        stepLog("python_spawn", {
          status: "pass",
          spawnMs: hrToMs(tSpawn),
          records: records.length,
        });

        // Step 6: find the result record (last non-trace record).
        const result = records
          .filter((r) => r && typeof r === "object" && r.trace !== true)
          .pop();
        if (!result) {
          stepLog("result_pick", {
            status: "fail",
            reason: "parser_no_output",
            traceRecords: records.length,
          });
          res
            .status(502)
            .json({ error: { code: "parser_no_output", requestId } });
          return;
        }

        if (result.ok === false) {
          stepLog("result_pick", {
            status: "fail",
            reason: result.code || "parse_failed",
            cliMessage: String(result.message || "").slice(0, 500),
          });
          res.status(422).json({
            error: {
              code: String(result.code || "parse_failed"),
              message: String(result.message || ""),
              requestId,
            },
          });
          return;
        }

        stepLog("result_pick", {
          status: "pass",
          map: result.map,
          durationSec: result.duration_sec,
        });
        res.json(result);
      } catch (err) {
        if (err instanceof PythonError) {
          const code = mapPythonErrorKindToCode(err.kind);
          stepLog("python_error", {
            status: "fail",
            kind: err.kind,
            code,
            exitCode: err.exitCode,
            stderr: typeof err.stderr === "string"
              ? err.stderr.slice(0, 500)
              : undefined,
            message: err.message,
          });
          res.status(502).json({
            error: { code, message: err.message, requestId },
          });
          return;
        }
        if (log) {
          log.error(
            {
              route: "preview_replay",
              requestId,
              elapsedMs: hrToMs(t0),
              err,
            },
            "preview_replay_unhandled",
          );
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
const HEALTH_RATE_LIMIT_PER_MIN = 30;
const PREVIEW_TIMEOUT_MS = 30 * 1000;
const HEALTH_TIMEOUT_MS = 10 * 1000;
// SC2 replays begin with the MPQ User Data Header ("MPQ\x1b"). The
// `\x1a` variant is the inner Archive Header — it lives somewhere
// inside the file at the offset specified by the user-data preamble,
// never at byte 0 in a real replay. Accept both so a stripped MPQ
// archive (rare, mostly synthetic test fixtures) still parses, but
// the canonical SC2Replay magic is `\x1b`.
const MPQ_MAGIC_USER_DATA = Buffer.from([0x4d, 0x50, 0x51, 0x1b]);
const MPQ_MAGIC_ARCHIVE = Buffer.from([0x4d, 0x50, 0x51, 0x1a]);

/**
 * Translate a `PythonError.kind` from the runner into the stable code
 * the front end's friendly-errors map keys on. The runner's `kind`
 * values come from `runPythonNdjson` — keep this in sync with that
 * file's switch statements.
 *
 * @param {string | undefined} kind
 * @returns {string}
 */
function mapPythonErrorKindToCode(kind) {
  switch (kind) {
    case "timeout":
      return "preview_timeout";
    case "oversize":
      return "parser_overflow";
    case "spawn_error":
    case "missing_analyzer_dir":
      return "preview_unavailable";
    case "exit_nonzero":
    default:
      return "python_error";
  }
}

/**
 * Convert a `process.hrtime.bigint()` start timestamp to elapsed
 * milliseconds. Centralised so every step uses the same precision.
 *
 * @param {bigint} start
 * @returns {number}
 */
function hrToMs(start) {
  const now = process.hrtime.bigint();
  return Number((now - start) / 1000000n);
}

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

/**
 * Probe every link in the parser chain and report whether each one
 * is reachable. Used by `GET /preview-replay/health` so an operator
 * can verify the cloud-side parser without uploading a real replay.
 *
 * The chain is:
 *   1. analyzer project dir reachable on disk
 *   2. configured Python executable exists on disk
 *   3. spawn-and-import sc2reader from that executable (via the
 *      CLI's `--self-test` mode)
 *
 * Each step is reported even when an earlier step fails so the
 * caller can see the full picture. The HTTP status is 200 only when
 * every step succeeds; 503 otherwise.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{
 *   healthy: boolean,
 *   body: Record<string, unknown>,
 *   flat: Record<string, unknown>,
 * }>}
 */
async function collectChainHealth(req) {
  const requestId = String(req.id || "");
  const checks = {
    analyzer_dir: { ok: false, path: null, error: null },
    python_exe: { ok: false, path: null, error: null },
    cli_self_test: { ok: false, error: null, output: null, durationMs: null },
  };

  const analyzerDir = resolveProjectDir();
  if (analyzerDir) {
    checks.analyzer_dir.ok = true;
    checks.analyzer_dir.path = analyzerDir;
  } else {
    checks.analyzer_dir.error = "analyzer_dir_not_found";
  }

  const pythonExe = resolvePythonExe();
  if (pythonExe) {
    checks.python_exe.ok = true;
    checks.python_exe.path = pythonExe;
  } else {
    checks.python_exe.error = "python_exe_not_found";
  }

  if (checks.analyzer_dir.ok && checks.python_exe.ok) {
    const t = process.hrtime.bigint();
    try {
      const records = await runPythonNdjson({
        script: "scripts/preview_replay_cli.py",
        args: ["--self-test"],
        timeoutMs: HEALTH_TIMEOUT_MS,
      });
      checks.cli_self_test.durationMs = hrToMs(t);
      const rec = records.find(
        (r) => r && typeof r === "object" && r.self_test === true,
      );
      if (!rec) {
        checks.cli_self_test.error = "no_self_test_record";
      } else if (rec.ok === true) {
        checks.cli_self_test.ok = true;
        checks.cli_self_test.output = rec;
      } else {
        checks.cli_self_test.error =
          rec.sc2reader_import_error || "self_test_failed";
        checks.cli_self_test.output = rec;
      }
    } catch (err) {
      checks.cli_self_test.durationMs = hrToMs(t);
      if (err instanceof PythonError) {
        checks.cli_self_test.error =
          `${err.kind || "python_error"}: ${err.message}`;
      } else {
        checks.cli_self_test.error = String(err && err.message ? err.message : err);
      }
    }
  }

  const healthy =
    checks.analyzer_dir.ok &&
    checks.python_exe.ok &&
    checks.cli_self_test.ok;

  const body = {
    ok: healthy,
    requestId,
    checks,
    timestamp: new Date().toISOString(),
  };

  // Flatten the report into pino-friendly fields so we can grep
  // per-check status without parsing nested JSON.
  const flat = {
    healthy,
    analyzerDirOk: checks.analyzer_dir.ok,
    analyzerDirPath: checks.analyzer_dir.path,
    pythonExeOk: checks.python_exe.ok,
    pythonExePath: checks.python_exe.path,
    cliSelfTestOk: checks.cli_self_test.ok,
    cliSelfTestError: checks.cli_self_test.error,
    cliSelfTestMs: checks.cli_self_test.durationMs,
    sc2reader_version:
      checks.cli_self_test.output &&
      checks.cli_self_test.output.sc2reader_version,
  };

  return { healthy, body, flat };
}

module.exports = {
  buildPublicReplayRouter,
  // Exported for tests.
  collectChainHealth,
  mapPythonErrorKindToCode,
};
