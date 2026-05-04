"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { TIMEOUTS, PYTHON } = require("../config/constants");

/**
 * Shared spawn-and-collect-NDJSON harness for the analyzer's Python
 * CLIs.
 *
 * The legacy stream-overlay-backend spawned scripts/macro_cli.py,
 * scripts/apm_cli.py, scripts/spatial_cli.py, scripts/ml_cli.py, and
 * scripts/bulk_import_cli.py the same way: each script emits one or
 * more JSON objects per line on stdout. This module centralises the
 * spawn protocol so route handlers stay tiny.
 *
 * Resolution rules (matches `pickPythonExe` / `pythonProjectDirOrErr`
 * in the legacy analyzer.js):
 *   - SC2_PY_PYTHON env var > "python3" on PATH.
 *   - SC2_PY_ANALYZER_DIR env var > /opt/sc2-analyzer.
 *
 * Render's Dockerfile installs the analyzer at /opt/sc2-analyzer and
 * pre-installs requirements.txt — so production lifts the defaults.
 */

const NDJSON_MAX_LINE_BYTES = 4 * 1024 * 1024;

class PythonError extends Error {
  /**
   * @param {string} message
   * @param {{ kind?: string, stderr?: string, exitCode?: number }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = "PythonError";
    if (opts.kind) this.kind = opts.kind;
    if (opts.stderr) this.stderr = opts.stderr;
    if (typeof opts.exitCode === "number") this.exitCode = opts.exitCode;
  }
}

/**
 * @typedef {{
 *   script: string,
 *   args?: string[],
 *   stdin?: string | Buffer,
 *   timeoutMs?: number,
 *   env?: NodeJS.ProcessEnv,
 *   onProgress?: (record: object) => void,
 *   pythonExe?: string,
 *   projectDir?: string,
 * }} PythonRunOpts
 */

/**
 * Run a Python CLI script and collect every JSON line it writes to
 * stdout. Resolves with an array of parsed objects in script order.
 *
 * Stops with a PythonError on non-zero exit if no records were emitted,
 * or on stdout/stderr that exceeds the per-line cap.
 *
 * @param {PythonRunOpts} opts
 * @returns {Promise<object[]>}
 */
function runPythonNdjson(opts) {
  return new Promise((resolve, reject) => {
    const projectDir = opts.projectDir || resolveProjectDir();
    if (!projectDir) {
      reject(
        new PythonError("python_project_dir_missing", {
          kind: "missing_analyzer_dir",
        }),
      );
      return;
    }
    const pythonExe = opts.pythonExe || pickPythonExe();
    const scriptPath = path.isAbsolute(opts.script)
      ? opts.script
      : path.join(projectDir, opts.script);
    const args = [scriptPath, ...(opts.args || [])];
    const proc = spawn(pythonExe, args, {
      cwd: projectDir,
      env: { ...(opts.env || process.env) },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (opts.stdin !== undefined) {
      proc.stdin.write(opts.stdin);
    }
    proc.stdin.end();

    /** @type {object[]} */
    const records = [];
    let stderr = "";
    let stdoutBuf = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        proc.kill("SIGKILL");
      } catch (_e) {
        // best-effort
      }
      reject(
        new PythonError("python_timeout", {
          kind: "timeout",
          stderr: stderr.slice(0, 4000),
        }),
      );
    }, opts.timeoutMs || TIMEOUTS.PYTHON_SPAWN_MS);

    proc.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        if (line.length > NDJSON_MAX_LINE_BYTES) {
          finished = true;
          clearTimeout(timer);
          try {
            proc.kill("SIGKILL");
          } catch (_e) {
            // best-effort
          }
          reject(
            new PythonError("python_line_too_large", { kind: "oversize" }),
          );
          return;
        }
        let obj;
        try {
          obj = JSON.parse(line);
        } catch (_e) {
          continue;
        }
        if (obj && typeof obj === "object") {
          records.push(obj);
          if (opts.onProgress) {
            try {
              opts.onProgress(obj);
            } catch (_progressErr) {
              // never let consumer errors kill the pipe
            }
          }
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > NDJSON_MAX_LINE_BYTES * 2) {
        stderr = stderr.slice(-NDJSON_MAX_LINE_BYTES);
      }
    });

    proc.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(
        new PythonError(err.message || "spawn_failed", {
          kind: "spawn_error",
          stderr,
        }),
      );
    });

    proc.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0 && records.length === 0) {
        reject(
          new PythonError(
            stderr.trim().slice(0, 2000) || `python_exit_${code}`,
            { kind: "exit_nonzero", stderr, exitCode: code || -1 },
          ),
        );
        return;
      }
      resolve(records);
    });
  });
}

/**
 * Streaming variant: returns a `cancel()` handle and pushes each
 * decoded NDJSON record into `onRecord`. Used by long-running CLIs
 * (bulk_import_cli, ml_cli train) so the route handler can return 202
 * immediately and stream progress over Socket.io.
 *
 * @param {PythonRunOpts & { onRecord: (record: object) => void, onClose: (info: { exitCode: number, stderr: string }) => void }} opts
 * @returns {{ pid: number | null, cancel: () => void }}
 */
function spawnPythonNdjson(opts) {
  const projectDir = opts.projectDir || resolveProjectDir();
  if (!projectDir) {
    setImmediate(() =>
      opts.onClose({ exitCode: -1, stderr: "python_project_dir_missing" }),
    );
    return { pid: null, cancel: () => {} };
  }
  const pythonExe = opts.pythonExe || pickPythonExe();
  const scriptPath = path.isAbsolute(opts.script)
    ? opts.script
    : path.join(projectDir, opts.script);
  const args = [scriptPath, ...(opts.args || [])];
  const proc = spawn(pythonExe, args, {
    cwd: projectDir,
    env: { ...(opts.env || process.env) },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (opts.stdin !== undefined) {
    proc.stdin.write(opts.stdin);
  }
  proc.stdin.end();
  let stderr = "";
  let buffer = "";
  let killed = false;
  const timer = setTimeout(() => {
    if (killed) return;
    killed = true;
    try {
      proc.kill("SIGKILL");
    } catch (_e) {
      // best-effort
    }
  }, opts.timeoutMs || TIMEOUTS.PYTHON_LONG_SPAWN_MS);
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === "object") {
          opts.onRecord(obj);
        }
      } catch (_e) {
        // skip malformed
      }
    }
  });
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > NDJSON_MAX_LINE_BYTES) {
      stderr = stderr.slice(-NDJSON_MAX_LINE_BYTES / 2);
    }
  });
  proc.on("close", (code) => {
    clearTimeout(timer);
    opts.onClose({ exitCode: typeof code === "number" ? code : -1, stderr });
  });
  return {
    pid: proc.pid || null,
    cancel: () => {
      if (killed) return;
      killed = true;
      try {
        proc.kill("SIGTERM");
      } catch (_e) {
        // best-effort
      }
    },
  };
}

/**
 * Persist a serialisable JS value to a tmp file and return its path.
 * Used to feed Mongo cursor pages into a Python CLI without inflating
 * the command line.
 *
 * @param {string} prefix
 * @param {string} extension
 * @param {string} contents
 * @returns {string}
 */
function writeTempFile(prefix, extension, contents) {
  const tmp = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`,
  );
  fs.writeFileSync(tmp, contents);
  return tmp;
}

/** @returns {string} */
function pickPythonExe() {
  const fromEnv = process.env[PYTHON.PYTHON_EXE_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return PYTHON.DEFAULT_EXE;
}

/** @returns {string | null} */
function resolveProjectDir() {
  const fromEnv = process.env[PYTHON.ANALYZER_DIR_ENV];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  if (fs.existsSync(PYTHON.DEFAULT_DIR)) return PYTHON.DEFAULT_DIR;
  return null;
}

/**
 * @returns {boolean} true when a Python project dir is reachable on
 * this host. Lets routes degrade to a clean 503 instead of spawning
 * and failing.
 */
function pythonAvailable() {
  return resolveProjectDir() !== null;
}

module.exports = {
  PythonError,
  runPythonNdjson,
  spawnPythonNdjson,
  writeTempFile,
  pickPythonExe,
  resolveProjectDir,
  pythonAvailable,
};
