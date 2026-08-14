"use strict";

const DEFAULT_MAX_ACTIVE = 1;
// Large batches may spend many seconds in sequential Mongo/R2 work. Five
// seconds avoids making every waiting agent resend megabytes once per second,
// while keeping newly finished live-game latency reasonable.
const RETRY_AFTER_SEC = 5;
const DEFAULT_BODY_TIMEOUT_MS = 45 * 1000;
const RELEASE_KEY = Symbol("replayIngestAdmissionRelease");

/**
 * Fail-fast admission control for the memory-heavy replay ingest endpoint.
 *
 * This middleware must run before ``express.json()``. A waiting queue at the
 * route would retain every caller's parsed multi-megabyte body while Mongo,
 * gzip and R2 work drained ahead of it; rejecting excess requests before body
 * parsing keeps memory bounded instead. The desktop agent treats 503 as
 * transient and durably requeues the complete batch, so backpressure delays
 * work without dropping a replay.
 *
 * The conservative default is one active ingest per process. The observed OOM
 * happened with one agent's two upload workers, so permitting that same
 * concurrency without measured RSS proof would preserve the failure mode.
 *
 * @param {{
 *   maxActive?: number,
 *   maxBodyBytes?: number,
 *   bodyTimeoutMs?: number,
 *   matchRequest?: (req: import('express').Request) => boolean,
 *   logger?: { warn?: (obj: object, msg: string) => void },
 * }} [opts]
 * @returns {import('express').RequestHandler}
 */
function buildReplayIngestAdmission(opts = {}) {
  const maxActive = positiveInt(opts.maxActive, DEFAULT_MAX_ACTIVE);
  const maxBodyBytes = positiveInt(opts.maxBodyBytes, 5 * 1024 * 1024);
  const bodyTimeoutMs = positiveInt(
    opts.bodyTimeoutMs,
    DEFAULT_BODY_TIMEOUT_MS,
  );
  let active = 0;
  const matchRequest = typeof opts.matchRequest === "function"
    ? opts.matchRequest
    : isReplayIngest;

  return function replayIngestAdmission(req, res, next) {
    if (!matchRequest(req)) {
      next();
      return;
    }
    // Production authenticates this endpoint before admission/body parsing.
    // Require that verified server-side state here as a fail-closed invariant;
    // a syntactically plausible fake Bearer must never occupy the global slot.
    if (!hasVerifiedReplayAuth(req)) {
      const code = hasBearerAuthorization(req) ? "invalid_token" : "missing_token";
      sendError(res, 401, code, "Authentication is required.", false);
      // Do not drain an untrusted chunked stream forever. Once the bounded
      // error reaches the client, close the socket without parsing the body.
      destroyAfterResponse(req, res);
      return;
    }

    const declaredBytes = parseContentLength(req.get("content-length"));
    if (declaredBytes !== null && declaredBytes > maxBodyBytes) {
      sendError(res, 413, "payload_too_large", "Request body is too large.", false);
      destroyAfterResponse(req, res);
      return;
    }

    if (active >= maxActive) {
      // Consume the body as an unbuffered stream before completing the early
      // response. Finishing while a client is still writing a multi-megabyte
      // payload can reset the TCP connection, making a deliberate 503 look
      // like an ambiguous network failure. Draining never materialises JSON,
      // so rejected concurrent uploads remain heap-bounded.
      if (req.log && typeof req.log.warn === "function") {
        req.log.warn(
          { active, maxActive },
          "replay_ingest_backpressure",
        );
      } else if (opts.logger && typeof opts.logger.warn === "function") {
        opts.logger.warn(
          { active, maxActive },
          "replay_ingest_backpressure",
        );
      }
      let streamedBytes = 0;
      let settled = false;
      /** @type {ReturnType<typeof setTimeout> | null} */
      let busyBodyTimer = null;
      const cleanupBusyBody = () => {
        if (busyBodyTimer) clearTimeout(busyBodyTimer);
        busyBodyTimer = null;
        req.removeListener("data", onBusyData);
        req.removeListener("end", respondBusy);
        req.removeListener("aborted", abandonBusyBody);
        res.removeListener("close", abandonBusyBody);
      };
      /** @type {(status: number, code: string, message: string, retryable?: boolean) => void} */
      const finishBusyBody = (status, code, message, retryable = true) => {
        if (settled) return;
        settled = true;
        cleanupBusyBody();
        sendError(res, status, code, message, retryable);
      };
      /** @param {Buffer|string} chunk */
      const onBusyData = (chunk) => {
        if (settled) return;
        streamedBytes += Buffer.isBuffer(chunk)
          ? chunk.length
          : Buffer.byteLength(String(chunk));
        if (streamedBytes > maxBodyBytes) {
          finishBusyBody(
            413,
            "payload_too_large",
            "Request body is too large.",
            false,
          );
          destroyAfterResponse(req, res);
        }
      };
      const respondBusy = () => {
        finishBusyBody(
          503,
          "replay_ingest_busy",
          "Replay ingest is busy; retry this batch shortly.",
        );
      };
      const abandonBusyBody = () => {
        if (settled) return;
        settled = true;
        cleanupBusyBody();
      };
      req.on("data", onBusyData);
      req.once("end", respondBusy);
      req.once("aborted", abandonBusyBody);
      res.once("close", abandonBusyBody);
      busyBodyTimer = setTimeout(() => {
        if (settled) return;
        finishBusyBody(
          408,
          "replay_ingest_body_timeout",
          "Replay upload body timed out.",
        );
        destroyAfterResponse(req, res);
      }, bodyTimeoutMs);
      if (typeof busyBodyTimer.unref === "function") busyBodyTimer.unref();
      if (req.readableEnded) respondBusy();
      else req.resume();
      return;
    }

    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
    };
    // POST /games calls this from its finally block after Mongo/R2 work really
    // stops. A client disconnect does not cancel that async work, so releasing
    // on ``close`` would incorrectly admit overlap.
    const state = { claimed: false, released: false, release };
    /** @type {any} */ (res).locals[RELEASE_KEY] = state;
    const bodyTimer = setTimeout(() => {
      if (state.claimed || state.released || req.readableEnded) return;
      state.released = true;
      release();
      sendError(
        res,
        408,
        "replay_ingest_body_timeout",
        "Replay upload body timed out.",
        true,
      );
      destroyAfterResponse(req, res);
    }, bodyTimeoutMs);
    if (typeof bodyTimer.unref === "function") bodyTimer.unref();
    const clearBodyTimer = () => clearTimeout(bodyTimer);
    req.once("end", clearBodyTimer);
    // Parser/auth failures never enter POST /games, so its finally block cannot
    // release them. A finished response is terminal. A socket close is safe to
    // release only before the route claims the slot; after claim, async R2/
    // Mongo work can outlive the disconnected client and releases in finally.
    res.once("finish", () => {
      clearBodyTimer();
      if (!state.claimed) {
        state.released = true;
        release();
      }
    });
    res.once("close", () => {
      clearBodyTimer();
      if (!state.claimed) {
        state.released = true;
        release();
      }
    });
    next();
  };
}

/**
 * @param {import('express').Response} res
 * @param {{allowMissing?: boolean}} [opts]
 * @returns {boolean} true only while this request still owns its slot
 */
function claimReplayIngestAdmission(res, opts = {}) {
  const state = /** @type {any} */ (res).locals?.[RELEASE_KEY];
  // Fail closed if a production route is mounted without its pre-parser gate.
  // Focused router tests may opt out explicitly; the assembled app never does.
  if (!state) return opts.allowMissing === true;
  if (typeof state !== "object" || state.released) return false;
  state.claimed = true;
  return true;
}

/** @param {import('express').Response} res */
function releaseReplayIngestAdmission(res) {
  const locals = /** @type {any} */ (res).locals;
  const state = locals && locals[RELEASE_KEY];
  if (!state || typeof state.release !== "function") return;
  state.released = true;
  state.release();
  delete locals[RELEASE_KEY];
}

/** @param {import('express').Request} req */
function isReplayIngest(req) {
  if (req.method !== "POST") return false;
  const path = String(req.originalUrl || req.url || "")
    .split("?", 1)[0]
    .replace(/\/+$/, "")
    .toLowerCase();
  return path === "/v1/games" || path === "/games";
}

/** @param {unknown} value @param {number} fallback */
function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** @param {unknown} value @returns {number|null} */
function parseContentLength(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : Number.POSITIVE_INFINITY;
}

/** @param {import('express').Request} req */
function hasBearerAuthorization(req) {
  const value = req.headers.authorization;
  return (
    typeof value === "string"
    && value.length <= 4103
    && /^Bearer [^\s]{1,4096}$/.test(value)
  );
}

/** @param {import('express').Request} req */
function hasVerifiedReplayAuth(req) {
  const auth = req.auth;
  return Boolean(
    auth
    && typeof auth.userId === "string"
    && auth.userId.length > 0
    && (auth.source === "device" || auth.source === "clerk"),
  );
}

/**
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {boolean} retryable
 */
function sendError(res, status, code, message, retryable) {
  if (res.headersSent || res.destroyed) return;
  if (retryable) res.set("Retry-After", String(RETRY_AFTER_SEC));
  res.set("Cache-Control", "no-store");
  res.status(status).json({ error: { code, message, retryable } });
}

/**
 * Stop reading an invalid/unbounded body only after the status reaches the
 * client, avoiding an ambiguous connection reset in place of 408/413.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function destroyAfterResponse(req, res) {
  const destroy = () => {
    if (!req.destroyed) req.destroy();
  };
  if (res.writableFinished) destroy();
  else res.once("finish", destroy);
}

module.exports = {
  buildReplayIngestAdmission,
  claimReplayIngestAdmission,
  releaseReplayIngestAdmission,
  isReplayIngest,
  // Exported only for focused route-matching tests.
  _internals: { isReplayIngest },
};
