"use strict";

// Background DB loader.
//
// PROBLEM: analyzer.js was calling fs.readFileSync + JSON.parse on
// MyOpponentHistory.json (≈27 MB) and meta_database.json (≈137 MB)
// on a 4-second setInterval and on first request. Each parse pegs
// the main event loop for hundreds of milliseconds, which is exactly
// why the opponents tab "takes forever to load when new replays land"
// — the browser's GET /api/opponents got queued behind a parse it
// could see was happening on disk every 4s.
//
// FIX: do the read+parse in a worker thread. Serve the previous
// in-memory snapshot the entire time. When the worker returns, swap
// the cache atomically and emit `analyzer_db_changed` so live SPA
// tabs refresh.
//
// This module is transport-agnostic. It owns timers + the worker;
// callers wire it to the dbCache slot and the Socket.io instance.

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { Worker } = require("node:worker_threads");

const DEFAULT_POLL_INTERVAL_MS = 2000;
const SIGNATURE_HEAD_BYTES = 4096;
const SIGNATURE_TAIL_BYTES = 4096;
const SIGNATURE_TAIL_THRESHOLD = 8192;

/**
 * Compute the cheap "did the file change" signature without parsing.
 * Same algorithm as analyzer.js#fileSignature so callers can swap
 * either side without invalidation surprises.
 *
 * @param {string} p
 * @returns {string|null}
 */
function fileSignature(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch (_) {
    return null;
  }
  let fd;
  try {
    fd = fs.openSync(p, "r");
    const head = Buffer.alloc(Math.min(SIGNATURE_HEAD_BYTES, st.size));
    fs.readSync(fd, head, 0, head.length, 0);
    const h = crypto.createHash("sha1").update(head);
    if (st.size > SIGNATURE_TAIL_THRESHOLD) {
      const tail = Buffer.alloc(SIGNATURE_TAIL_BYTES);
      fs.readSync(fd, tail, 0, tail.length, st.size - SIGNATURE_TAIL_BYTES);
      h.update(tail);
    }
    return `${st.mtimeMs}:${st.size}:${h.digest("hex").slice(0, 12)}`;
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Start a background loader for a single file → dbCache slot.
 *
 * @param {{
 *   filePath: string,
 *   slot: { data: object, signature: string|null, revision: number, loadedAt: number, loading?: boolean },
 *   onReloaded: (info: {revision: number, signature: string|null}) => void,
 *   onError?: (err: Error) => void,
 *   pollMs?: number,
 *   logger?: { info: Function, warn: Function, error: Function },
 * }} opts
 * @returns {{ stop: () => void, triggerNow: () => void }}
 */
function startLoader(opts) {
  const log = opts.logger || console;
  const pollMs = opts.pollMs || DEFAULT_POLL_INTERVAL_MS;
  let stopped = false;
  let timer = null;

  const tick = () => {
    if (stopped) return;
    try {
      const sig = fileSignature(opts.filePath);
      const slot = opts.slot;
      if (sig && sig !== slot.signature && !slot.loading) {
        slot.loading = true;
        runWorker(opts.filePath)
          .then((parsed) => {
            slot.data = parsed || {};
            slot.signature = sig;
            slot.revision += 1;
            slot.loadedAt = Date.now();
            opts.onReloaded({ revision: slot.revision, signature: sig });
          })
          .catch((err) => {
            log.warn(
              `[bg-loader] worker failed for ${opts.filePath}: ${err.message}`,
            );
            if (opts.onError) opts.onError(err);
          })
          .finally(() => {
            slot.loading = false;
            timer = setTimeout(tick, pollMs);
          });
        return;
      }
    } catch (err) {
      log.error("[bg-loader] tick error:", err);
    }
    timer = setTimeout(tick, pollMs);
  };

  // Kick off immediately so first request never blocks on a cold load.
  timer = setTimeout(tick, 0);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    triggerNow() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, 0);
    },
  };
}

/**
 * Run the parse in a worker thread. Swallows parser errors and bubbles
 * them as rejections so the caller can decide whether to retry.
 *
 * @param {string} filePath
 * @returns {Promise<object>}
 */
function runWorker(filePath) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, "background-loader.worker.js");
    const w = new Worker(workerPath, { workerData: { filePath } });
    let settled = false;
    w.once("message", (msg) => {
      settled = true;
      if (msg && msg.ok) resolve(msg.data || {});
      else reject(new Error(msg && msg.error ? msg.error : "worker_failed"));
    });
    w.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    w.once("exit", (code) => {
      if (settled) return;
      if (code !== 0) reject(new Error(`worker_exit_${code}`));
    });
  });
}

module.exports = { startLoader, fileSignature };
