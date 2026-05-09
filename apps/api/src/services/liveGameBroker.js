"use strict";

/**
 * In-memory pub/sub for the Live Game Bridge — fans out the agent's
 * outbound ``LiveGameState`` envelopes (see ``POST /v1/agent/live``)
 * to subscribed SSE clients (see ``GET /v1/me/live``).
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
 */

class LiveGameBroker {
  constructor() {
    /** @type {Map<string, Set<(env: object) => void>>} */
    this._subs = new Map();
    /** @type {Map<string, {envelope: object, ts: number}>} */
    this._latest = new Map();
    // Keep latest envelopes for at most 30 minutes — beyond that a
    // user is plainly not in a live game and a stale envelope on
    // a fresh page-load would mislead the widget.
    this._maxAgeMs = 30 * 60 * 1000;
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
   * @param {string} userId
   * @param {object} envelope
   */
  publish(userId, envelope) {
    if (!userId || !envelope || typeof envelope !== "object") return;
    this._latest.set(userId, { envelope, ts: Date.now() });
    const bucket = this._subs.get(userId);
    if (!bucket) return;
    for (const cb of bucket) {
      try {
        cb(envelope);
      } catch (err) {
        // ignore — the SSE route's heartbeat will eventually detect
        // a dead writer and drop the subscription.
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
