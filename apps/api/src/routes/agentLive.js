"use strict";

const express = require("express");

/**
 * /v1/agent/live + /v1/me/live — the cloud's role in the Live Game
 * Bridge.
 *
 * The agent on the user's PC POSTs a typed ``LiveGameState`` envelope
 * here at ~1 Hz while a match is in progress (see
 * ``apps/agent/sc2tools_agent/live/transport.py``). We hand the
 * envelope to a per-process broker which fans it out to every SSE
 * subscriber watching the user's web tabs.
 *
 * Architectural choice — rapid POSTs over chunked upload:
 *   - Same shape as ``/v1/games`` so the agent's ApiClient already
 *     knows how to retry, honour Retry-After, and back off.
 *   - Each envelope is independent — one drop is not catastrophic;
 *     the next 1 s tick brings a fresh snapshot.
 *   - SSE on the read side is a streaming response, but the write
 *     side fires-and-forgets. Mismatching the two is fine.
 *
 * Auth:
 *   - POST /v1/agent/live → device token (same as /v1/games).
 *   - GET  /v1/me/live    → Clerk session (same as /v1/me/profile).
 *
 * @param {{
 *   broker: import('../services/liveGameBroker').LiveGameBroker,
 *   auth: import('express').RequestHandler,
 *   engagement?: import('../services/multichatEngagement').MultichatEngagementService,
 *   overlayTokens?: import('../services/types').OverlayTokensService,
 *   logger?: import('pino').Logger,
 * }} deps
 */
function buildAgentLiveRouter(deps) {
  const router = express.Router();
  const log = deps.logger || null;

  router.post("/agent/live", deps.auth, (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      // We don't restrict to ``source === "device"`` — letting Clerk
      // sessions push too is useful for browser-based diagnostics
      // (the test page can simulate a live game) and the broker is
      // per-user so there's no cross-tenant risk.
      const env = req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body
        : null;
      if (!env) {
        res.status(400).json({ error: { code: "invalid_envelope" } });
        return;
      }
      // Stamp server-side metadata so the SSE consumer can tell a
      // freshly-arrived envelope apart from the broker's cached
      // replay-on-subscribe.
      const enriched = {
        ...env,
        receivedAt: Date.now(),
      };
      deps.broker.publish(auth.userId, enriched);
      // Crystal Ball: a loading/starting match opens a prediction
      // window on every active overlay token. Idempotent per gameKey
      // (the agent posts ~1 Hz), best-effort, never blocks the ack.
      if (
        deps.engagement &&
        deps.overlayTokens &&
        (enriched.phase === "match_loading" ||
          enriched.phase === "match_started") &&
        typeof enriched.gameKey === "string" &&
        enriched.gameKey &&
        !enriched.isReplay
      ) {
        const engagement = deps.engagement;
        const overlayTokens = deps.overlayTokens;
        void (async () => {
          try {
            const items = await overlayTokens.list(auth.userId);
            const tokens = items
              .filter((t) => t && t.token && !t.revokedAt)
              .map((t) => t.token);
            await engagement.openPrediction(tokens, {
              gameKey: enriched.gameKey,
              opponent: enriched.opponent?.name,
            });
          } catch {
            /* engagement is advisory */
          }
        })();
      }
      if (log && typeof log.debug === "function") {
        log.debug(
          { userId: auth.userId, phase: enriched.phase },
          "agent_live_received",
        );
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * /v1/me/live — Server-Sent Events stream for the authenticated
 * user's web tabs.
 *
 * The handler keeps the connection open, streams every envelope the
 * broker publishes for ``userId``, and emits a heartbeat comment line
 * every 25 s so proxies (Render, CDN) don't reap an idle connection.
 *
 * @param {{
 *   broker: import('../services/liveGameBroker').LiveGameBroker,
 *   auth: import('express').RequestHandler,
 *   logger?: import('pino').Logger,
 * }} deps
 */
function buildMeLiveRouter(deps) {
  const router = express.Router();

  router.get("/me/live", deps.auth, (req, res, _next) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: { code: "auth_required" } });
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    // Disable response buffering on Express (some Node middleware
    // buffers responses by default).
    res.setHeader("x-accel-buffering", "no");
    // Initial flush so the client knows the connection is open.
    res.write(": ok\n\n");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    // ---- Subscriber lifecycle ----
    // One idempotent cleanup wired to EVERY way a subscriber can die.
    // Pre-hardening, teardown hung solely on `req.on("close")`: a
    // response-side error or a stalled client left the broker
    // subscription (and its per-tick writes) alive indefinitely — the
    // broker's "heartbeat will eventually detect a dead writer" note
    // was aspirational; nothing actually dropped a stalled subscriber.
    let done = false;
    /** @type {NodeJS.Timeout | null} */
    let stallTimer = null;
    /** @type {NodeJS.Timeout | null} */
    let heartbeat = null;
    let unsubscribe = () => {};

    /** @param {string} reason */
    const cleanup = (reason) => {
      if (done) return;
      done = true;
      // ``heartbeat`` may still be null: the broker replays its cached
      // envelope synchronously inside ``subscribe``, and a write
      // failure there reaches cleanup before the interval is set.
      if (heartbeat) clearInterval(heartbeat);
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
      unsubscribe();
      if (deps.logger && reason && reason !== "client_closed") {
        deps.logger.warn(
          { userId: auth.userId, reason },
          "sse_subscriber_dropped",
        );
      }
      try {
        res.end();
      } catch (_) {
        // already closed
      }
    };

    // Backpressure: `res.write()` returning false means the client
    // isn't reading and Node is buffering in memory. A healthy client
    // drains within milliseconds; one that hasn't drained within the
    // stall window is gone (OBS scene closed mid-write, dead NAT
    // mapping, proxy black-holing) — drop it instead of buffering
    // 1 Hz envelopes forever. The client's auto-reconnect + resync
    // restores state if it ever comes back.
    const STALL_TIMEOUT_MS = 10_000;
    const armStallTimer = () => {
      if (stallTimer || done) return;
      stallTimer = setTimeout(() => {
        cleanup("stalled_no_drain");
        try {
          res.destroy();
        } catch (_) {
          // already gone
        }
      }, STALL_TIMEOUT_MS);
      if (typeof stallTimer.unref === "function") stallTimer.unref();
      res.once("drain", () => {
        if (stallTimer) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
      });
    };

    /** @param {string} chunk */
    const writeChunk = (chunk) => {
      if (done) return;
      try {
        const ok = res.write(chunk);
        if (!ok) armStallTimer();
      } catch (_err) {
        cleanup("write_failed");
      }
    };

    /** @param {unknown} envelope */
    const writeEnvelope = (envelope) => {
      writeChunk(`data: ${JSON.stringify(envelope)}\n\n`);
    };
    unsubscribe = deps.broker.subscribe(auth.userId, writeEnvelope);
    if (done) {
      // The broker's synchronous replay-on-subscribe hit a dead
      // response and cleanup already ran with the no-op unsubscribe —
      // release the real subscription it just created.
      unsubscribe();
      return;
    }

    // Heartbeat — SSE comment line, ignored by clients but keeps
    // intermediaries from reaping the socket. Routed through the same
    // backpressure-aware writer so a zombie socket gets detected even
    // when no game is live (no envelopes flowing).
    const heartbeatMs = 25000;
    heartbeat = setInterval(() => {
      writeChunk(": heartbeat\n\n");
    }, heartbeatMs);
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    req.on("close", () => cleanup("client_closed"));
    req.on("error", () => cleanup("request_error"));
    res.on("close", () => cleanup("client_closed"));
    res.on("error", () => cleanup("response_error"));
  });

  return router;
}

module.exports = { buildAgentLiveRouter, buildMeLiveRouter };
