"use strict";

const { LIMITS, COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { HEAVY_FIELDS } = require("./gameDetails");

/**
 * Games service. One document per (userId, gameId). Idempotent on
 * insert: if the agent re-uploads after a retry, we update existing
 * record rather than duplicate.
 */
class GamesService {
  /**
   * @param {{games: import('mongodb').Collection}} db
   * @param {{
   *   gameDetails?: import('./gameDetails').GameDetailsService,
   *   users?: { getProfile(userId: string): Promise<{ region?: string }> },
   * }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    // Optional dep so unit tests that only need the slim-row code
    // path can still construct GamesService without a details stub.
    // The ingest path checks for presence before forwarding.
    this.gameDetails = opts.gameDetails || null;
    // Optional UsersService so todaySession can stamp the streamer's
    // region onto the session payload (e.g. "NA 5343" on the SPA's
    // session widget). When unavailable, the region field stays unset
    // and the widget falls back to MMR-only.
    this.users = opts.users || null;
  }

  /**
   * Insert or update a game record. Returns true if it was new.
   *
   * Heavy fields (build logs, macroBreakdown, apmCurve, spatial) are
   * peeled off the input and persisted into ``game_details`` via the
   * injected GameDetailsService. The slim row that lands in
   * ``games`` is roughly 3 kB instead of ~48 kB, which is what makes
   * list/aggregation queries scan-cheap at scale (the v0.4.3 split
   * — see ``services/gameDetails.js`` for the rationale).
   *
   * @param {string} userId
   * @param {{gameId: string, date: string | Date} & Record<string, unknown>} game
   * @returns {Promise<boolean>}
   */
  async upsert(userId, game) {
    if (!game || !game.gameId) throw new Error("gameId required");
    const date = game.date instanceof Date ? game.date : new Date(game.date);
    if (Number.isNaN(date.getTime())) throw new Error("invalid game.date");
    /** @type {Record<string, any>} */
    const doc = { ...game, userId, date };
    delete doc._id;
    delete doc._schemaVersion;
    // Capture heavy fields BEFORE the slim doc is finalised so we
    // can hand them to GameDetailsService. The slim row that lands
    // in ``games`` is then stripped of every heavy field plus the
    // legacy early-log fields. Total slim size: ~3 kB / doc instead
    // of ~30 kB.
    //
    // Why we $unset every heavy field on the slim row even though
    // we already deleted it from ``doc``: pre-cutover documents
    // that already exist in ``games`` carry the heavy fields inline.
    // The $set patch alone would leave them sitting on disk
    // indefinitely. The $unset clears them as part of the same
    // upsert — incremental cutover happens naturally as users
    // re-upload.
    /** @type {Record<string, any>} */
    const heavy = {};
    for (const k of HEAVY_FIELDS) {
      if (doc[k] !== undefined) heavy[k] = doc[k];
      delete doc[k];
    }
    delete doc.earlyBuildLog;
    delete doc.oppEarlyBuildLog;
    stampVersion(doc, COLLECTIONS.GAMES);
    /** @type {Record<string, string>} */
    const unset = { earlyBuildLog: "", oppEarlyBuildLog: "" };
    for (const k of HEAVY_FIELDS) unset[k] = "";
    const res = await this.db.games.updateOne(
      { userId, gameId: game.gameId },
      {
        $setOnInsert: { createdAt: new Date() },
        $set: doc,
        $unset: unset,
      },
      { upsert: true },
    );
    if (this.gameDetails && Object.keys(heavy).length > 0) {
      // Detail-write failures DO propagate now that the slim row no
      // longer carries the heavy fields. A silent failure here
      // would leave the per-game inspector permanently empty. The
      // ingest route catches and logs; failure of one game doesn't
      // block subsequent games in a batch upload.
      await this.gameDetails.upsert(userId, game.gameId, date, heavy);
    }
    return res.upsertedCount === 1;
  }

  /**
   * Page games by date, newest first. Optional opponent filter.
   *
   * @param {string} userId
   * @param {{limit?: number, before?: Date, oppPulseId?: string}} [opts]
   */
  async list(userId, opts = {}) {
    const limit = clampLimit(opts.limit, LIMITS.GAMES_PAGE_SIZE);
    /** @type {Record<string, any>} */
    const filter = { userId };
    if (opts.oppPulseId) filter.oppPulseId = opts.oppPulseId;
    if (opts.before instanceof Date && !Number.isNaN(opts.before.getTime())) {
      filter.date = { $lt: opts.before };
    }
    const items = await this.db.games
      .find(filter, { projection: { _id: 0 } })
      .sort({ date: -1 })
      .limit(limit + 1)
      .toArray();
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextBefore = hasMore ? page[page.length - 1].date : null;
    return { items: page, nextBefore };
  }

  /**
   * @param {string} userId
   * @param {string} gameId
   */
  async get(userId, gameId) {
    return this.db.games.findOne(
      { userId, gameId },
      { projection: { _id: 0 } },
    );
  }

  /**
   * @param {string} userId
   * @returns {Promise<{total: number, latest: Date|null}>}
   */
  async stats(userId) {
    const total = await this.db.games.countDocuments({ userId });
    const latest = await this.db.games
      .find({ userId }, { projection: { date: 1, _id: 0 } })
      .sort({ date: -1 })
      .limit(1)
      .toArray();
    return { total, latest: latest[0]?.date || null };
  }

  /**
   * Today's session aggregate — wins, losses, total game count, and an
   * MMR delta when the agent has populated ``myMmr`` on the game rows.
   *
   * Used by the hosted OBS overlay's session-record widget. The widget
   * must work whether or not the local agent is currently posting
   * pre/post-game live events: as long as games are landing in the
   * cloud (via the agent's normal upload path) we can derive the
   * session card directly here.
   *
   * "Today" is anchored to the overlay's wall clock by accepting an
   * IANA timezone identifier. An invalid or missing timezone falls
   * back to UTC so the day boundary is still well-defined; on a clock
   * skew or unrecognised TZ the widget still ticks rather than going
   * blank.
   *
   * The pre-filter trims the candidate set to a 48-hour window before
   * the per-row timezone math runs. 48h is a strict superset of "today
   * in any IANA TZ" (max ±14h offset = 28h diff between two TZ
   * day-starts) plus headroom for clock skew. For a typical streamer
   * with ≤50 games per day the in-JS filter is cheap and avoids
   * pushing $dateTrunc into Mongo for every game row.
   *
   * @param {string} userId
   * @param {string} [timezone] IANA tz, defaults to UTC
   * @returns {Promise<{
   *   wins: number,
   *   losses: number,
   *   games: number,
   *   mmrStart?: number,
   *   mmrCurrent?: number,
   *   region?: string,
   *   sessionStartedAt?: string,
   *   streak?: { kind: 'win'|'loss', count: number },
   * }>}
   */
  async todaySession(userId, timezone) {
    const tz = pickTimezone(timezone);
    // 14-day window so ``mmrCurrent`` always has a recent value to fall
    // back on even when the streamer hasn't queued today. The today-key
    // filter below still keeps wins/losses/games/streak scoped to the
    // current day; the wider window only feeds the MMR fallback.
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const rows = await this.db.games
      .find(
        { userId, date: { $gte: cutoff } },
        { projection: { _id: 0, result: 1, date: 1, myMmr: 1 } },
      )
      .sort({ date: 1 })
      .toArray();
    const todayKey = formatDayKey(new Date(), tz);
    let wins = 0;
    let losses = 0;
    let games = 0;
    /** @type {number|undefined} */
    let mmrStart;
    /** @type {number|undefined} */
    let mmrCurrent;
    /** @type {number|undefined} */
    let lastKnownMmr;
    /** @type {string|undefined} */
    let sessionStartedAt;
    /** @type {Array<'win'|'loss'>} */
    const todayResults = [];
    for (const row of rows) {
      const date = row.date instanceof Date ? row.date : new Date(row.date);
      if (Number.isNaN(date.getTime())) continue;
      const my = Number(row.myMmr);
      // Track the most recent known MMR across the whole window so the
      // session widget can render a meaningful number even on days
      // where the streamer hasn't queued yet. Rows are pre-sorted asc
      // so the last assignment wins.
      if (Number.isFinite(my)) lastKnownMmr = my;
      if (formatDayKey(date, tz) !== todayKey) continue;
      games += 1;
      if (sessionStartedAt === undefined) sessionStartedAt = date.toISOString();
      const r = String(row.result || "").toLowerCase();
      if (r === "victory" || r === "win") {
        wins += 1;
        todayResults.push("win");
      } else if (r === "defeat" || r === "loss") {
        losses += 1;
        todayResults.push("loss");
      }
      if (Number.isFinite(my)) {
        if (mmrStart === undefined) mmrStart = my;
        mmrCurrent = my;
      }
    }
    // Today had games but none stamped MMR — fall back to whatever the
    // most recent prior game reported. Keeps the MMR line populated
    // for newer agents that occasionally drop the field on a corrupt
    // replay parse.
    if (mmrCurrent === undefined && lastKnownMmr !== undefined) {
      mmrCurrent = lastKnownMmr;
    }
    /**
     * @type {{
     *   wins: number, losses: number, games: number,
     *   mmrStart?: number, mmrCurrent?: number,
     *   region?: string, sessionStartedAt?: string,
     *   streak?: { kind: 'win'|'loss', count: number },
     * }}
     */
    const out = { wins, losses, games };
    if (mmrStart !== undefined) out.mmrStart = mmrStart;
    if (mmrCurrent !== undefined) out.mmrCurrent = mmrCurrent;
    if (sessionStartedAt !== undefined) out.sessionStartedAt = sessionStartedAt;
    // Current run = consecutive same-result trail at the end of the day's
    // game list. Surfaces the SPA's "W4" / "L2" streak chip on the
    // session widget without requiring a second collection lookup.
    if (todayResults.length > 0) {
      const last = todayResults[todayResults.length - 1];
      let count = 1;
      for (let i = todayResults.length - 2; i >= 0; i -= 1) {
        if (todayResults[i] !== last) break;
        count += 1;
      }
      if (count >= 2) out.streak = { kind: last, count };
    }
    if (this.users) {
      try {
        const profile = await this.users.getProfile(userId);
        if (profile && typeof profile.region === "string" && profile.region) {
          out.region = profile.region.toUpperCase();
        }
      } catch {
        // Region is decorative; a lookup failure must never block the
        // session payload from emitting.
      }
    }
    return out;
  }
}

/**
 * Validate an IANA timezone, falling back to UTC.
 * @param {unknown} raw
 * @returns {string}
 */
function pickTimezone(raw) {
  if (typeof raw !== "string" || !raw) return "UTC";
  const s = raw.trim();
  if (!s) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s });
    return s;
  } catch {
    return "UTC";
  }
}

/**
 * Format a Date as ``YYYY-MM-DD`` in the supplied timezone. Mirrors
 * ``apps/web/lib/timeseries.ts#localDateKey`` so the server's
 * "what is today" answer matches what the overlay computes locally.
 *
 * @param {Date|string} value
 * @param {string} timezone
 * @returns {string}
 */
function formatDayKey(value, timezone) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

/** @param {unknown} raw @param {number} fallback @returns {number} */
function clampLimit(raw, fallback) {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, fallback);
}

module.exports = { GamesService };
