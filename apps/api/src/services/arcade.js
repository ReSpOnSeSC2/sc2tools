"use strict";

const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

/**
 * Arcade service. Two responsibilities:
 *
 *   1. resolveQuests(userId, card)
 *      Re-evaluates an active Bingo: Ladder Edition card against the
 *      user's recent games and returns which cells have ticked. Pure
 *      derivation — does NOT mutate the card; the client persists the
 *      ticked state via /v1/me/preferences/arcade so the resolver
 *      stays idempotent.
 *
 *   2. Stock Market weekly P&L leaderboard
 *      submitLeaderboard(userId, entry) and listLeaderboard(weekKey)
 *      backed by the ``community_builds`` collection's neighbour —
 *      we use a separate ``arcade_leaderboard`` collection so the
 *      community-builds K-anon path stays unaffected. Opt-in: the row
 *      is only written when the user explicitly submits.
 */

const ARCADE_LEADERBOARD = "arcade_leaderboard";

class ArcadeService {
  /**
   * @param {import('../db/connect').DbContext & { arcadeLeaderboard?: any }} db
   * @param {{ games: import('../services/types').GamesService }} deps
   */
  constructor(db, deps) {
    this.db = db;
    this.games = deps.games;
    // Mongo collection lazy handle. Some test harnesses construct the
    // service without a pre-bound collection; resolve on first use so
    // the service stays cheap to instantiate.
    this._collection = null;
  }

  _coll() {
    if (this._collection) return this._collection;
    if (this.db.arcadeLeaderboard) {
      this._collection = this.db.arcadeLeaderboard;
      return this._collection;
    }
    if (typeof this.db.collection === "function") {
      this._collection = this.db.collection(ARCADE_LEADERBOARD);
      return this._collection;
    }
    throw new Error("arcade_leaderboard collection unavailable");
  }

  /**
   * Resolve every objective on an active card against the user's games
   * since ``card.startedAt``. Each objective declares a ``predicate``
   * key + ``params``; the predicate registry below is the source of
   * truth for what can appear on a card.
   *
   * @param {string} userId
   * @param {{
   *   startedAt: string,
   *   objectives: Array<{ id: string, predicate: string, params?: any }>,
   * }} card
   * @returns {Promise<{ resolved: Array<{ id: string, ticked: boolean, gameId?: string }> }>}
   */
  async resolveQuests(userId, card) {
    if (!card || !Array.isArray(card.objectives)) {
      return { resolved: [] };
    }
    const start = parseIso(card.startedAt) || new Date(0);
    const games = await this.db.games
      .find(
        { userId, date: { $gte: start } },
        { projection: { _id: 0 } },
      )
      .sort({ date: 1 })
      .limit(500)
      .toArray();
    /** @type {Array<{ id: string, ticked: boolean, gameId?: string }>} */
    const resolved = [];
    for (const obj of card.objectives) {
      const predicate = PREDICATES[obj.predicate];
      if (!predicate) {
        resolved.push({ id: obj.id, ticked: false });
        continue;
      }
      const hit = predicate(games, obj.params || {});
      if (hit) {
        resolved.push({ id: obj.id, ticked: true, gameId: hit });
      } else {
        resolved.push({ id: obj.id, ticked: false });
      }
    }
    return { resolved };
  }

  /**
   * Submit (insert/replace) one row for a given (userId, weekKey).
   * Idempotent on (userId, weekKey) so multiple submits in the same
   * week overwrite. Display name is opt-in — empty string means the
   * row is anonymous and the leaderboard shows "Anonymous N".
   *
   * @param {string} userId
   * @param {{ weekKey: string, pnlPct: number, displayName?: string }} entry
   */
  async submitLeaderboard(userId, entry) {
    if (!entry || typeof entry !== "object") return false;
    const weekKey = String(entry.weekKey || "").trim();
    const pnl = Number(entry.pnlPct);
    if (!isWeekKey(weekKey)) return false;
    if (!Number.isFinite(pnl)) return false;
    const display = typeof entry.displayName === "string"
      ? entry.displayName.trim().slice(0, 60)
      : "";
    const now = new Date();
    /** @type {Record<string, any>} */
    const doc = {
      userId,
      weekKey,
      pnlPct: clamp(pnl, -100, 1000),
      displayName: display,
      updatedAt: now,
    };
    stampVersion(doc, "arcade_leaderboard");
    await this._coll().updateOne(
      { userId, weekKey },
      { $set: doc, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
    return true;
  }

  /**
   * List the top N rows for a given weekKey. Anonymises rows whose
   * displayName is empty and assigns rank by sorted P&L. Returns at
   * most ``limit`` rows; the underlying collection is capped here, not
   * upstream.
   *
   * @param {string} weekKey
   * @param {{ limit?: number }} [opts]
   */
  async listLeaderboard(weekKey, opts = {}) {
    if (!isWeekKey(weekKey)) {
      return { weekKey, items: [] };
    }
    const limit = Math.min(Math.max(1, Number(opts.limit) || 50), 200);
    const rows = await this._coll()
      .find(
        { weekKey },
        { projection: { _id: 0, userId: 1, displayName: 1, pnlPct: 1 } },
      )
      .sort({ pnlPct: -1, updatedAt: 1 })
      .limit(limit)
      .toArray();
    let anonCounter = 1;
    const items = rows.map((r, i) => ({
      rank: i + 1,
      // Stable per-user anonymised handle so the same anonymous user
      // doesn't read as a different "Anonymous N" between page loads
      // within a week.
      displayName: r.displayName && r.displayName.length > 0
        ? r.displayName
        : `Anonymous ${anonCounter++}`,
      pnlPct: r.pnlPct,
      isAnonymous: !r.displayName || r.displayName.length === 0,
    }));
    return { weekKey, items };
  }
}

/**
 * Predicate registry for Bingo objectives. Each predicate receives the
 * user's games-in-window (chronological) and the objective's params,
 * and returns the gameId that satisfied it (truthy) or null.
 *
 * Predicates are pure: no DB calls, no I/O, no time math beyond what's
 * on the row. They MUST tolerate missing fields — the games collection
 * is wide and old rows can lack any modern field.
 *
 * @type {Record<string, (games: any[], params: any) => string | null>}
 */
const PREDICATES = {
  /** Played at least one game in the window. Free-space center cell. */
  any_game: (games) => firstId(games),
  /** Won any game in the window. */
  any_win: (games) => firstId(games.filter(isWin)),
  /** Won on a specific map (params.map: string). */
  win_on_map: (games, params) => {
    const map = String(params.map || "").toLowerCase();
    return firstId(games.filter((g) => isWin(g) && lc(g.map) === map));
  },
  /** Won as a specific race (params.race: P/T/Z). */
  win_as_race: (games, params) => {
    const race = String(params.race || "").charAt(0).toUpperCase();
    return firstId(games.filter((g) => isWin(g) && raceLetter(g.myRace) === race));
  },
  /** Won vs a specific race (params.race). */
  win_vs_race: (games, params) => {
    const race = String(params.race || "").charAt(0).toUpperCase();
    return firstId(
      games.filter((g) => isWin(g) && raceLetter(g.oppRace) === race),
    );
  },
  /** Won vs an opponent at least N MMR above (params.diff: number). */
  win_vs_higher_mmr: (games, params) => {
    const diff = Number(params.diff) || 100;
    return firstId(
      games.filter((g) => {
        if (!isWin(g)) return false;
        const my = Number(g.myMmr);
        const op = oppMmr(g);
        return Number.isFinite(my) && Number.isFinite(op) && (op - my) >= diff;
      }),
    );
  },
  /** Won 3 in a row anywhere in the window. */
  three_in_a_row_win: (games) => {
    let streak = 0;
    let lastId = null;
    for (const g of games) {
      const out = outcome(g);
      if (out === "W") {
        streak += 1;
        lastId = String(g.gameId);
        if (streak >= 3) return lastId;
      } else if (out === "L") {
        streak = 0;
        lastId = null;
      }
    }
    return null;
  },
  /** Won a game shorter than params.maxSec seconds. */
  win_under_seconds: (games, params) => {
    const cap = Number(params.maxSec) || 360;
    return firstId(
      games.filter((g) => isWin(g) && Number(g.duration) > 0 && Number(g.duration) < cap),
    );
  },
  /** Won a game longer than params.minSec seconds. */
  win_over_seconds: (games, params) => {
    const min = Number(params.minSec) || 1500;
    return firstId(
      games.filter((g) => isWin(g) && Number(g.duration) > min),
    );
  },
  /** Hit a macro_score above params.minScore. */
  macro_above: (games, params) => {
    const min = Number(params.minScore) || 70;
    return firstId(
      games.filter((g) => Number(g.macro_score) > min),
    );
  },
};

/**
 * Game outcome → "W" / "L" / "U". Mirrors the SPA's ``gameOutcome``
 * helper in lib/h2hSeries.ts so server/client stay in lockstep.
 *
 * @param {any} g
 * @returns {"W" | "L" | "U"}
 */
function outcome(g) {
  const r = String(g.result || "").toLowerCase();
  if (r === "win" || r === "victory") return "W";
  if (r === "loss" || r === "defeat") return "L";
  return "U";
}
const isWin = (g) => outcome(g) === "W";
const lc = (v) => (typeof v === "string" ? v.toLowerCase() : "");
const raceLetter = (v) =>
  typeof v === "string" && v.length > 0 ? v.charAt(0).toUpperCase() : "";

/**
 * Best-effort opponent MMR — the column was renamed across agent
 * versions, so check the modern + legacy fields. Returns NaN when
 * neither is populated.
 *
 * @param {any} g
 * @returns {number}
 */
function oppMmr(g) {
  const cand = [
    g?.opponent?.mmr,
    g?.opp_mmr,
    g?.oppMmr,
  ];
  for (const v of cand) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return Number.NaN;
}

function firstId(games) {
  if (!games.length) return null;
  return String(games[0].gameId);
}

/** Validate a YYYY-Www ISO week key. */
function isWeekKey(s) {
  return /^\d{4}-W\d{2}$/.test(s);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function parseIso(s) {
  if (typeof s !== "string") return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = { ArcadeService, PREDICATES, ARCADE_LEADERBOARD };
// Suppress an unused-collection-name warning if the collection is
// touched lazily elsewhere — re-export keeps it discoverable.
void COLLECTIONS;
