"use strict";

// Keep-alive worker.
//
// The API runs on Render's "starter" web service, which idles after a
// stretch of no inbound traffic and then eats a 30+ second cold start when
// the next visitor lands. Socket.io clients that hold persistent
// connections normally keep the API warm, but the Next.js web frontend
// shares the same idle problem — and may have no live clients overnight.
//
// This worker fires off lightweight HTTP GETs against a configurable list
// of URLs every N minutes (default 13 — under Render's 15-minute idle
// window). Targets are typically:
//   - the public web origin's /api/ping       (keeps the frontend warm)
//   - the API's own /v1/ping                  (defensive belt-and-braces)
//
// The worker is best-effort: failed pings are logged and dropped, never
// thrown. It intentionally uses native fetch (Node 18+) rather than a
// fancy HTTP client so it adds zero dependency surface.

const DEFAULT_INTERVAL_MS = 13 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;

/**
 * @typedef {{
 *   start: () => void,
 *   stop: () => Promise<void>,
 *   isRunning: () => boolean,
 *   pingNow: () => Promise<KeepaliveResult[]>,
 * }} KeepaliveWorker
 *
 * @typedef {{
 *   url: string,
 *   ok: boolean,
 *   status?: number,
 *   durationMs: number,
 *   error?: string,
 * }} KeepaliveResult
 */

/**
 * Build a keep-alive worker. Returns a controller — caller decides when
 * to start() and must call stop() during graceful shutdown so the
 * setInterval handle doesn't keep the process alive past SIGTERM.
 *
 * @param {{
 *   targets: ReadonlyArray<string>,
 *   intervalMs?: number,
 *   logger: import('pino').Logger,
 *   fetchImpl?: typeof fetch,
 *   userAgent?: string,
 * }} opts
 * @returns {KeepaliveWorker}
 */
function buildKeepaliveWorker(opts) {
  const targets = sanitizeTargets(opts.targets);
  const intervalMs = clampInterval(opts.intervalMs);
  const logger = opts.logger.child({ component: "keepalive" });
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const userAgent = opts.userAgent || "sc2tools-keepalive/1";

  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {Promise<KeepaliveResult[]> | null} */
  let inFlight = null;

  if (typeof fetchImpl !== "function") {
    logger.warn(
      "keepalive_fetch_unavailable: native fetch missing, worker disabled",
    );
  }

  function start() {
    if (timer) return;
    if (targets.length === 0) {
      logger.info("keepalive_disabled: no targets configured");
      return;
    }
    if (typeof fetchImpl !== "function") return;
    logger.info(
      { targets, intervalMs },
      "keepalive_started",
    );
    // Fire once immediately so a cold deploy starts warming peers without
    // waiting a full interval. Then schedule the recurring tick.
    pingNow().catch(() => {});
    timer = setInterval(() => {
      pingNow().catch(() => {});
    }, intervalMs);
    // Don't keep the event loop alive solely because of this timer —
    // shutdown handlers should still get a chance to run.
    if (typeof timer.unref === "function") timer.unref();
  }

  async function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // already logged inside pingNow
      }
    }
  }

  function isRunning() {
    return timer !== null;
  }

  /**
   * Ping every target once. Resolves with one result per target —
   * failures included — so callers can introspect for tests/admin.
   * Concurrent calls coalesce onto the same in-flight promise so a slow
   * tick can't pile up overlapping fan-outs.
   *
   * @returns {Promise<KeepaliveResult[]>}
   */
  function pingNow() {
    if (typeof fetchImpl !== "function") return Promise.resolve([]);
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const results = await Promise.all(
          targets.map((url) => pingOne(url, fetchImpl, userAgent, logger)),
        );
        const failures = results.filter((r) => !r.ok);
        if (failures.length > 0) {
          logger.warn(
            {
              failures: failures.map((f) => ({
                url: f.url,
                error: f.error,
                status: f.status,
              })),
            },
            "keepalive_partial_failure",
          );
        } else {
          logger.debug({ results }, "keepalive_tick_ok");
        }
        return results;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return { start, stop, isRunning, pingNow };
}

/**
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @param {string} userAgent
 * @param {import('pino').Logger} logger
 * @returns {Promise<KeepaliveResult>}
 */
async function pingOne(url, fetchImpl, userAgent, logger) {
  const startedAt = Date.now();
  // Native AbortController in Node 18+ — gives us a real fetch timeout
  // without pulling in p-timeout or similar.
  const ctl = new AbortController();
  const timeoutHandle = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": userAgent,
        "cache-control": "no-cache",
      },
      signal: ctl.signal,
    });
    const durationMs = Date.now() - startedAt;
    const ok = res.ok;
    if (!ok) {
      logger.debug(
        { url, status: res.status, durationMs },
        "keepalive_non_2xx",
      );
    }
    return { url, ok, status: res.status, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    return { url, ok: false, durationMs, error: message };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Drop blank entries, dedupe, validate as absolute http(s) URLs.
 *
 * @param {ReadonlyArray<string>} raw
 * @returns {string[]}
 */
function sanitizeTargets(raw) {
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const entry of raw) {
    const trimmed = String(entry || "").trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    const normalized = parsed.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * @param {number|undefined} raw
 * @returns {number}
 */
function clampInterval(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.max(MIN_INTERVAL_MS, Math.floor(raw));
}

module.exports = {
  buildKeepaliveWorker,
  // Exported for tests.
  __internal: { sanitizeTargets, clampInterval },
};
