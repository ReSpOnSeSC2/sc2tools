"use strict";

/**
 * Stream Guardian warnings for the Stream Dock.
 *
 * The paired agent reads OBS and decides what is wrong; it tells the server
 * only which of four fixed rules fire. The server keeps the newest list per
 * user in memory (a warning exists only while its cause does), pushes it to
 * that user's Dock sockets and replays it to a Dock that connects later. A
 * list the agent stops refreshing expires, so a closed agent cannot leave a
 * banner behind.
 *
 * @typedef {{ rule: string, since: number }} GuardianWarning
 * @typedef {{ warnings: GuardianWarning[], at: number, ageMs: number }} GuardianPublication
 * `ageMs` is how long the agent's report has been held, so a Dock that gets a replay ages it by the server clock, not its own.
 */

const RULES = Object.freeze(["mic_muted", "stream_unstable", "not_recording", "stuck_on_break"]);
/** The agent repeats an unchanged list every minute; three missed beats clear it. */
const EXPIRES_MS = 3 * 60_000;
const FUTURE_SKEW_MS = 60_000;
const EVENT = "overlay:guardian";

class StreamGuardianService {
  /** @param {{ io?: { to: (room: string) => { emit: (event: string, payload: unknown) => unknown } }, now?: () => number }} [deps] */
  constructor({ io, now = Date.now } = {}) {
    this.io = io;
    this.now = now;
    /** @type {Map<string, GuardianPublication>} */
    this.byUser = new Map();
  }

  /**
   * Keep only known rules, once each, with a start time that is not in the future.
   * @param {unknown} raw
   * @returns {GuardianWarning[]}
   */
  sanitize(raw) {
    if (!Array.isArray(raw)) return [];
    const now = this.now();
    /** @type {Map<string, GuardianWarning>} */
    const kept = new Map();
    for (const row of raw.slice(0, RULES.length * 2)) {
      const entry = /** @type {{ rule?: unknown, since?: unknown }} */ (row && typeof row === "object" ? row : {});
      if (typeof entry.rule !== "string" || !RULES.includes(entry.rule) || kept.has(entry.rule)) continue;
      const since = typeof entry.since === "number" && Number.isSafeInteger(entry.since)
        && entry.since > 0 && entry.since <= now + FUTURE_SKEW_MS ? entry.since : now;
      kept.set(entry.rule, { rule: entry.rule, since });
    }
    return [...kept.values()];
  }

  /**
   * @param {string} userId
   * @param {unknown} raw
   * @returns {GuardianPublication}
   */
  publish(userId, raw) {
    const now = this.now();
    this.prune(now);
    const publication = { warnings: this.sanitize(raw), at: now, ageMs: 0 };
    if (publication.warnings.length) this.byUser.set(userId, publication);
    else this.byUser.delete(userId);
    this.io?.to(`user:${userId}`).emit(EVENT, publication);
    return publication;
  }

  /**
   * What a Dock that just connected should show, or null when nothing is wrong.
   * @param {string} userId
   * @returns {GuardianPublication|null}
   */
  latest(userId) {
    const held = this.byUser.get(userId);
    if (!held) return null;
    if (this.now() - held.at > EXPIRES_MS) {
      this.byUser.delete(userId);
      return null;
    }
    return { ...held, ageMs: this.now() - held.at };
  }

  /** @param {number} now */
  prune(now) {
    for (const [userId, held] of this.byUser) {
      if (now - held.at > EXPIRES_MS) this.byUser.delete(userId);
    }
  }
}

module.exports = { StreamGuardianService, GUARDIAN_RULES: RULES, GUARDIAN_EXPIRES_MS: EXPIRES_MS };
