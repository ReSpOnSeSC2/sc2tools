"use strict";

/**
 * MultichatStudioService — live "stream studio" state for the
 * multichat overlay family: the pinned chat highlight, the active
 * chat poll, the stream goals, the studio blocklist, and the
 * session-recap trigger.
 *
 * State is per overlay TOKEN (the dock and every Browser Source of a
 * token share one studio), persisted in Mongo so an OBS restart or
 * API deploy never loses a running poll, and broadcast over the
 * token's existing socket room as ``overlay:multichat`` so the dock's
 * actions land on stream instantly.
 *
 * Everything stored here is strict-sanitized on write — the dock is
 * token-authed (the token IS the bearer, same threat model as the
 * overlay socket), so hostile input must not be able to persist
 * anything the widgets wouldn't render safely.
 */

const POLL_MAX_OPTIONS = 6;
const POLL_MAX_TEXT = 120;
const GOALS_MAX = 4;
const GOAL_MAX_LABEL = 40;
const HIGHLIGHT_MAX_TEXT = 500;
const BLOCKLIST_MAX = 50;

class MultichatStudioService {
  /**
   * @param {{ multichatStudio: import('mongodb').Collection }} db
   * @param {{ io?: import('socket.io').Server }} [deps]
   */
  constructor(db, deps = {}) {
    this.col = db.multichatStudio;
    this.io = deps.io || null;
  }

  /**
   * Current studio state for a token. Absent doc → empty defaults so
   * widgets can boot unconditionally.
   *
   * @param {string} token
   */
  async get(token) {
    const doc = await this.col.findOne(
      { token },
      { projection: { _id: 0, token: 0 } },
    );
    return {
      highlight: doc?.highlight ?? null,
      poll: doc?.poll ?? null,
      goals: Array.isArray(doc?.goals) ? doc.goals : [],
      blockedUsers: Array.isArray(doc?.blockedUsers) ? doc.blockedUsers : [],
      recapSeq: Number(doc?.recapSeq) || 0,
      scene: doc?.scene ?? null,
      updatedAt: doc?.updatedAt ?? null,
    };
  }

  /**
   * Apply a partial update ({highlight} | {poll} | {goals} |
   * {blockedUsers} | {recap:true}) — sanitized, persisted, broadcast.
   *
   * @param {string} token
   * @param {Record<string, unknown>} patch
   */
  async update(token, patch) {
    /** @type {Record<string, any>} */
    const set = { updatedAt: new Date() };
    /** @type {Record<string, any>} */
    const inc = {};
    if ("highlight" in patch) {
      set.highlight = sanitizeHighlight(patch.highlight);
    }
    if ("poll" in patch) {
      set.poll = sanitizePoll(patch.poll);
    }
    if ("goals" in patch) {
      set.goals = sanitizeGoals(patch.goals);
    }
    if ("blockedUsers" in patch) {
      set.blockedUsers = sanitizeBlockedUsers(patch.blockedUsers);
    }
    if ("scene" in patch) {
      set.scene = sanitizeScene(patch.scene);
    }
    if (patch.recap === true) {
      inc.recapSeq = 1;
    }
    /** @type {Record<string, any>} */
    const updateDoc = { $set: set, $setOnInsert: { token } };
    if (Object.keys(inc).length > 0) updateDoc.$inc = inc;
    await this.col.updateOne({ token }, updateDoc, { upsert: true });
    const state = await this.get(token);
    if (this.io) {
      this.io.to(`overlay:${token}`).emit("overlay:multichat", state);
    }
    return state;
  }
}

/** @param {unknown} raw */
function sanitizeHighlight(raw) {
  if (!raw || typeof raw !== "object") return null;
  const h = /** @type {Record<string, any>} */ (raw);
  const text = String(h.text ?? "").trim().slice(0, HIGHLIGHT_MAX_TEXT);
  const user = String(h.user ?? "").trim().slice(0, 60);
  if (!text || !user) return null;
  const platform = ["twitch", "kick", "youtube", "tiktok"].includes(h.platform)
    ? h.platform
    : "twitch";
  return { platform, user, text, atMs: Date.now() };
}

/** @param {unknown} raw */
function sanitizePoll(raw) {
  if (!raw || typeof raw !== "object") return null;
  const p = /** @type {Record<string, any>} */ (raw);
  const question = String(p.question ?? "").trim().slice(0, POLL_MAX_TEXT);
  const options = (Array.isArray(p.options) ? p.options : [])
    .map((o) => String(o ?? "").trim().slice(0, POLL_MAX_TEXT))
    .filter(Boolean)
    .slice(0, POLL_MAX_OPTIONS);
  if (!question || options.length < 2) return null;
  return {
    question,
    options,
    startedAtMs: Number.isFinite(Number(p.startedAtMs))
      ? Number(p.startedAtMs)
      : Date.now(),
    // "open" collects votes; "closed" shows final results until cleared.
    status: p.status === "closed" ? "closed" : "open",
  };
}

/** @param {unknown} raw */
function sanitizeGoals(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Array<Record<string, any>>} */
  const out = [];
  for (const g of raw.slice(0, GOALS_MAX)) {
    if (!g || typeof g !== "object") continue;
    const label = String(g.label ?? "").trim().slice(0, GOAL_MAX_LABEL);
    const current = Math.max(0, Math.round(Number(g.current) || 0));
    const target = Math.max(1, Math.round(Number(g.target) || 0));
    if (!label) continue;
    out.push({ label, current, target });
  }
  return out;
}

const SCENE_MODES = ["brb", "starting"];
const SCENE_MESSAGE_MAX = 80;
/** Countdown targets clamp to now+24h — a fat-fingered year-long
 * countdown shouldn't persist. */
const SCENE_COUNTDOWN_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Scene state for the full-screen BRB / Starting Soon widget.
 * ``null`` (mode "none" or junk) means live — the widget renders
 * transparent.
 *
 * @param {unknown} raw
 */
function sanitizeScene(raw) {
  if (!raw || typeof raw !== "object") return null;
  const s = /** @type {Record<string, any>} */ (raw);
  if (!SCENE_MODES.includes(s.mode)) return null;
  const message = String(s.message ?? "").trim().slice(0, SCENE_MESSAGE_MAX);
  const ends = Number(s.countdownEndsAt);
  const now = Date.now();
  const countdownEndsAt =
    Number.isFinite(ends) && ends > now
      ? Math.min(ends, now + SCENE_COUNTDOWN_MAX_MS)
      : null;
  return { mode: s.mode, message, countdownEndsAt, setAtMs: now };
}

/** @param {unknown} raw */
function sanitizeBlockedUsers(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const out = [];
  for (const u of raw) {
    const name = String(u ?? "").trim().toLowerCase().replace(/^@/, "").slice(0, 60);
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= BLOCKLIST_MAX) break;
  }
  return out;
}

module.exports = {
  MultichatStudioService,
  sanitizeHighlight,
  sanitizePoll,
  sanitizeGoals,
  sanitizeBlockedUsers,
  sanitizeScene,
};
