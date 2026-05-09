"use strict";

/**
 * In-memory pub/sub for the Live Game Bridge — fans out the agent's
 * outbound ``LiveGameState`` envelopes (see ``POST /v1/agent/live``)
 * to two surfaces:
 *
 *   1. ``GET /v1/me/live`` Server-Sent Events subscribers (the user's
 *      ``/app`` dashboard tab).
 *   2. Socket.io ``overlay:<token>`` rooms (every active overlay token
 *      the user has minted — drives the OBS / Streamlabs Browser
 *      Source widgets at ``sc2tools.com/overlay/<token>/widget/<name>``).
 *
 * Keyed by ``userId`` so each user's web tabs only see their own
 * state. The agent's bearer token authenticates the POST and stamps
 * the userId on the envelope; the SSE endpoint authenticates the
 * subscriber via Clerk and forwards only matching envelopes.
 *
 * Why not Redis: this is a fan-out for a per-user real-time channel
 * that doesn't need to survive a process restart (the agent will
 * re-emit on its next 1 Hz tick). A single in-process broker is the
 * right shape for the cloud's current single-instance deployment;
 * if/when we shard the API across multiple Render instances, swap
 * this for a Redis-backed pub/sub without touching the routes.
 *
 * Memory bound: each subscriber receives the LATEST envelope on
 * subscribe (the broker keeps a single snapshot per user) and live
 * deltas thereafter. No history queue, no replay buffer — the
 * agent's polling cadence makes catch-up irrelevant.
 *
 * Overlay fan-out is per-token (not per-user-room) on purpose: a
 * streamer can mint multiple tokens (main scene / friend test) and
 * we may eventually filter the envelope per-token (enabledWidgets).
 * Today the same envelope goes to every active token, but the loop
 * is already shaped for per-token policy.
 */

class LiveGameBroker {
  /**
   * @param {{
   *   io?: import('socket.io').Server,
   *   overlayTokens?: import('./types').OverlayTokensService,
   *   logger?: import('pino').Logger,
   *   enrich?: (userId: string, envelope: object) => Promise<object>,
   * }} [deps]
   */
  constructor(deps = {}) {
    /** @type {Map<string, Set<(env: object) => void>>} */
    this._subs = new Map();
    /** @type {Map<string, {envelope: object, ts: number}>} */
    this._latest = new Map();
    // Keep latest envelopes for at most 30 minutes — beyond that a
    // user is plainly not in a live game and a stale envelope on
    // a fresh page-load would mislead the widget.
    this._maxAgeMs = 30 * 60 * 1000;
    this._io = deps.io || null;
    this._overlayTokens = deps.overlayTokens || null;
    this._logger = deps.logger || null;
    this._enrich = typeof deps.enrich === "function" ? deps.enrich : null;
    // Telemetry counters surfaced in `/v1/agent/live` logs and (later)
    // a metrics endpoint. Per-process, not per-user — for a per-user
    // health signal we use the freshness of `_latest`.
    this.counters = {
      published: 0,
      sse_emit_ok: 0,
      sse_emit_failed: 0,
      overlay_emit_ok: 0,
      overlay_emit_failed: 0,
      enrich_ok: 0,
      enrich_failed: 0,
    };
  }

  /**
   * Subscribe to ``userId``'s live envelopes. The callback receives
   * the latest cached envelope (if any AND fresh) on subscribe so a
   * mid-game web tab opens with widgets already populated.
   *
   * @param {string} userId
   * @param {(envelope: object) => void} cb
   * @returns {() => void} unsubscribe function
   */
  subscribe(userId, cb) {
    if (!userId || typeof cb !== "function") return () => {};
    let bucket = this._subs.get(userId);
    if (!bucket) {
      bucket = new Set();
      this._subs.set(userId, bucket);
    }
    bucket.add(cb);
    // Replay the latest snapshot if it's fresh enough.
    const cached = this._latest.get(userId);
    if (cached && Date.now() - cached.ts < this._maxAgeMs) {
      try {
        cb(cached.envelope);
      } catch (err) {
        // Swallow — a buggy subscriber must not break others.
      }
    }
    return () => {
      const live = this._subs.get(userId);
      if (live) {
        live.delete(cb);
        if (live.size === 0) this._subs.delete(userId);
      }
    };
  }

  /**
   * Publish a fresh envelope for ``userId``. Non-blocking — every
   * subscriber callback is wrapped in try/catch so the agent's POST
   * response time isn't held hostage by a slow SSE writer.
   *
   * Fan-out order:
   *   1. SSE subscribers (synchronous — they're in-process callbacks)
   *   2. Socket.io ``overlay:<token>`` rooms (async — token list
   *      requires a Mongo round trip; fired-and-forgotten so the
   *      agent's POST returns within ms)
   *
   * Either fan-out failing must not crash the other.
   *
   * @param {string} userId
   * @param {object} envelope
   */
  publish(userId, envelope) {
    if (!userId || !envelope || typeof envelope !== "object") return;
    this.counters.published += 1;
    // First fan-out: the partial envelope as-is. Streamers see the
    // basic opponent identity (name + race + Pulse MMR) within ms of
    // the agent's POST.
    this._broadcast(userId, envelope);
    // If an enricher is wired, run it asynchronously and fan out the
    // enriched envelope when ready. The first envelope of a new
    // opponent pays one Mongo aggregation (~50 ms cold); every
    // subsequent envelope of the same match hits the per-(userId,
    // oppName, oppRace) cache and resolves in microseconds. The
    // enriched re-emit follows the same shape — clients see two
    // updates in quick succession, the second carrying the
    // ``streamerHistory`` block. Mirrors the agent bridge's
    // partial-then-Pulse-enriched pattern.
    if (this._enrich) {
      Promise.resolve(this._enrich(userId, envelope))
        .then((enriched) => {
          if (!enriched || enriched === envelope) return;
          if (typeof enriched !== "object") return;
          this.counters.enrich_ok += 1;
          this._broadcast(userId, enriched);
        })
        .catch((err) => {
          this.counters.enrich_failed += 1;
          if (this._logger && typeof this._logger.warn === "function") {
            this._logger.warn(
              { err, userId },
              "live_game_broker_enrich_failed",
            );
          }
        });
    }
  }

  /**
   * Internal: one fan-out pass. Updates the latest snapshot, fires
   * SSE callbacks, and kicks off Socket.io overlay emit. Called once
   * for the partial envelope and (optionally) again for the enriched
   * one.
   *
   * @param {string} userId
   * @param {object} envelope
   */
  _broadcast(userId, envelope) {
    this._latest.set(userId, { envelope, ts: Date.now() });
    const bucket = this._subs.get(userId);
    if (bucket) {
      for (const cb of bucket) {
        try {
          cb(envelope);
          this.counters.sse_emit_ok += 1;
        } catch (err) {
          this.counters.sse_emit_failed += 1;
          // ignore — the SSE route's heartbeat will eventually detect
          // a dead writer and drop the subscription.
        }
      }
    }
    // Socket.io overlay fan-out runs after the SSE writes so the
    // dashboard tab and the OBS Browser Source see the envelope at
    // roughly the same wall-clock moment. We don't await — the agent
    // gets its 200 immediately; per-token emit failures are logged
    // by ``_fanOutToOverlayTokens`` itself.
    if (this._io && this._overlayTokens) {
      this._fanOutToOverlayTokens(userId, envelope).catch((err) => {
        if (this._logger && typeof this._logger.warn === "function") {
          this._logger.warn(
            { err, userId },
            "live_game_broker_overlay_fanout_failed",
          );
        }
      });
    }
  }

  /**
   * Per-token Socket.io emit. Iterates the user's active overlay
   * tokens and emits ``overlay:liveGame`` to each ``overlay:<token>``
   * room. A single token's emit failure (Socket.io throws) doesn't
   * stop the loop — the next active token still gets the envelope.
   *
   * @param {string} userId
   * @param {object} envelope
   */
  async _fanOutToOverlayTokens(userId, envelope) {
    if (!this._io || !this._overlayTokens || !userId) return;
    let tokens;
    try {
      tokens = await this._overlayTokens.list(userId);
    } catch (err) {
      this.counters.overlay_emit_failed += 1;
      if (this._logger && typeof this._logger.warn === "function") {
        this._logger.warn(
          { err, userId },
          "live_game_broker_token_list_failed",
        );
      }
      return;
    }
    if (!Array.isArray(tokens) || tokens.length === 0) return;
    for (const t of tokens) {
      if (!t || !t.token) continue;
      // Mirror the post-game ``emitOverlayLive`` filter in
      // routes/games.js — a leaked-then-revoked token must not still
      // receive live data after revocation.
      if (t.revokedAt) continue;
      try {
        this._io
          .to(`overlay:${t.token}`)
          .emit("overlay:liveGame", envelope);
        this.counters.overlay_emit_ok += 1;
      } catch (err) {
        this.counters.overlay_emit_failed += 1;
        if (this._logger && typeof this._logger.warn === "function") {
          this._logger.warn(
            { err, userId, token: t.token.slice(0, 6) + "…" },
            "live_game_broker_overlay_emit_failed",
          );
        }
      }
    }
  }

  /**
   * @param {string} userId
   * @returns {object|null} the latest cached envelope or null.
   */
  latest(userId) {
    const hit = this._latest.get(userId);
    if (!hit) return null;
    if (Date.now() - hit.ts > this._maxAgeMs) {
      this._latest.delete(userId);
      return null;
    }
    return hit.envelope;
  }

  subscriberCount(userId) {
    return this._subs.get(userId)?.size || 0;
  }

  /** Test helper. */
  clear() {
    this._subs.clear();
    this._latest.clear();
  }
}

module.exports = { LiveGameBroker };
