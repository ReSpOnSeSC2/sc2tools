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

    const writeEnvelope = (envelope) => {
      try {
        res.write(`data: ${JSON.stringify(envelope)}\n\n`);
      } catch (_err) {
        // Connection died — the unsubscribe in 'close' will tidy.
      }
    };
    const unsubscribe = deps.broker.subscribe(auth.userId, writeEnvelope);

    // Heartbeat — SSE comment line, ignored by clients but keeps
    // intermediaries from reaping the socket.
    const heartbeatMs = 25000;
    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch (_err) {
        // ignore — client gone, the close handler will clean up.
      }
    }, heartbeatMs);
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      try {
        res.end();
      } catch (_) {
        // already closed
      }
    });
  });

  return router;
}

module.exports = { buildAgentLiveRouter, buildMeLiveRouter };
