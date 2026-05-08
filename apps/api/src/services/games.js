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
   *   users?: {
   *     getProfile(userId: string): Promise<{
   *       region?: string,
   *       pulseId?: string,
   *     }>,
   *   },
   *   pulseMmr?: {
   *     getCurrentMmr(pulseId: string): Promise<{
   *       mmr: number,
   *       region: string | null,
   *     } | null>,
   *     getCurrentMmrByToon?(toonHandle: string): Promise<{
   *       mmr: number,
   *       region: string | null,
   *     } | null>,
   *   },
   *   logger?: { info: (obj: Record<string, unknown>, msg: string) => void },
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
    // Optional PulseMmrService — Tier-3 fallback that hits sc2pulse
    // for the user's current 1v1 ladder rating when no game in the
    // entire history carries a usable myMmr. Unavailable in unit tests
    // where the network is mocked; falls through silently.
    this.pulseMmr = opts.pulseMmr || null;
    // Optional pino-style logger so todaySession can emit a single
    // structured trace line per resolution attempt. The session
    // widget has five fallback tiers; without a per-tier line a
    // streamer who sees "—" on the overlay can't tell whether the
    // games-row scan missed, the toon-handle SC2Pulse search missed,
    // or there's no profile.pulseId. Defaults to a no-op so unit
    // tests don't have to plumb a logger through.
    this.logger = opts.logger || null;
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
    // 14-day window covers the typical W-L horizon. The today-key
    // filter below still pins wins/losses/games/streak to the current
    // day; the wider window only feeds the MMR-fallback inside the
    // loop. A separate, time-unbounded query further down handles the
    // case where today's games (and the last 14 days') were all
    // unranked / customs / AI matches that carry no MMR.
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const rows = await this.db.games
      .find(
        { userId, date: { $gte: cutoff } },
        {
          projection: {
            _id: 0,
            result: 1,
            date: 1,
            myMmr: 1,
            // Streamer's own toon handle. Lets the Tier-3 SC2Pulse
            // fallback resolve their CURRENT 1v1 ladder rating when no
            // game in their history carries `myMmr` and they haven't
            // pasted a numeric pulseId into Settings → Profile.
            myToonHandle: 1,
            // ``opponent.toonHandle`` is "<region>-S<season>-<realm>-<id>".
            // The first segment (1=NA, 2=EU, 3=KR/TW, 5=CN, 6=SEA) is
            // a reliable region hint when the user profile hasn't been
            // filled in.
            "opponent.toonHandle": 1,
          },
        },
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
    /** @type {string|undefined} */
    let lastKnownToonHandle;
    /** @type {string|undefined} */
    let lastKnownMyToonHandle;
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
      const toon = row.opponent && row.opponent.toonHandle;
      if (typeof toon === "string" && toon.length > 0) {
        lastKnownToonHandle = toon;
      }
      const myToon = row.myToonHandle;
      if (typeof myToon === "string" && myToon.length > 0) {
        lastKnownMyToonHandle = myToon;
      }
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
    /**
     * Resolution path — tagged so logs and tests can compare without
     * scraping a free-text reason field.
     *
     *   ``games_today``     — earliest-good-MMR-of-today path hit.
     *   ``games_window``    — 14-day in-memory fallback hit.
     *   ``games_anytime``   — unbounded findOne fallback hit.
     *   ``profile_sticky``  — agent's last-known-MMR ping on the user
     *                         profile. Sits between ``games_anytime``
     *                         and the SC2Pulse network calls because
     *                         it's fast (one row read) and survives
     *                         the games collection being wiped.
     *   ``pulse_pulseid`` / ``pulse_toon`` — SC2Pulse queried via the
     *                         profile's ``pulseId`` or the streamer's
     *                         ``myToonHandle`` from a recent game.
     *   ``unresolved``      — every tier missed; widget paints ``—``.
     *
     * @type {'games_today'|'games_window'|'games_anytime'|'profile_sticky'|'pulse_pulseid'|'pulse_toon'|'unresolved'|'none'}
     */
    let mmrSource = mmrCurrent !== undefined ? "games_today" : "none";
    // Tier-1 fallback: today had games but none carried MMR — surface
    // the most recent MMR from the 14-day window.
    if (mmrCurrent === undefined && lastKnownMmr !== undefined) {
      mmrCurrent = lastKnownMmr;
      mmrSource = "games_window";
    }
    // Tier-2 fallback: nothing in the last 14 days carried MMR. Reach
    // back to the most recent game ever that did so the session widget
    // still renders a number for streamers whose recent week was
    // unranked. Cheap one-row lookup; only runs when the in-memory
    // pass missed.
    if (mmrCurrent === undefined) {
      try {
        const newest = await this.db.games.findOne(
          { userId, myMmr: { $exists: true, $type: "number" } },
          {
            projection: { _id: 0, myMmr: 1 },
            sort: { date: -1 },
          },
        );
        const m = newest ? Number(newest.myMmr) : NaN;
        if (Number.isFinite(m)) {
          mmrCurrent = m;
          mmrSource = "games_anytime";
        }
      } catch {
        // findOne failure is non-fatal — leave mmrCurrent undefined
        // and let the renderer fall back to its placeholder.
      }
    }
    // Read the user profile up front so we can use ``region``,
    // ``pulseId``, AND the agent-pinged ``lastKnownMmr`` in the same
    // flow — the SC2Pulse fallbacks below depend on ``pulseId`` being
    // present, and the sticky-MMR tier just below depends on
    // ``lastKnownMmr``.
    /**
     * @type {{
     *   region?: string,
     *   pulseId?: string,
     *   lastKnownMmr?: number,
     *   lastKnownMmrRegion?: string,
     * }}
     */
    let profile = {};
    if (this.users) {
      try {
        profile = (await this.users.getProfile(userId)) || {};
      } catch {
        // Profile is decorative; a lookup failure must never block the
        // session payload from emitting.
        profile = {};
      }
    }
    // Sticky-MMR tier: the agent pings a focused
    // ``POST /v1/me/last-mmr`` on every successfully-parsed replay,
    // so this profile field carries the most recent MMR even when
    // the games collection has nothing usable (e.g. all 18 of a
    // streamer's lifetime rows pre-date the v0.5.6 extraction fix).
    // Cheaper than SC2Pulse (no network round-trip) so it sits
    // before the pulse_* tiers in the fallback chain.
    if (
      mmrCurrent === undefined &&
      typeof profile.lastKnownMmr === "number" &&
      Number.isFinite(profile.lastKnownMmr)
    ) {
      mmrCurrent = profile.lastKnownMmr;
      mmrSource = "profile_sticky";
    }
    /** @type {string|undefined} */
    let pulseRegion;
    // Tier-3 fallback: still no MMR after walking every game we have.
    // Hit SC2Pulse for the user's current 1v1 ladder rating using the
    // pulseId from their profile. Streamers whose ranked replays were
    // uploaded before MMR extraction landed (or who play exclusively
    // on a build that doesn't carry `scaled_rating`) get a real number
    // on the overlay instead of a permanent "—".
    if (
      mmrCurrent === undefined &&
      this.pulseMmr &&
      profile &&
      typeof profile.pulseId === "string" &&
      profile.pulseId
    ) {
      try {
        const pulse = await this.pulseMmr.getCurrentMmr(profile.pulseId);
        if (pulse && Number.isFinite(pulse.mmr)) {
          mmrCurrent = pulse.mmr;
          mmrSource = "pulse_pulseid";
          if (typeof pulse.region === "string" && pulse.region) {
            pulseRegion = pulse.region;
          }
        }
      } catch {
        // SC2Pulse outages or transient timeouts are non-fatal — the
        // PulseMmrService already swallows network errors and returns
        // null; this catch is belt-and-braces against a thrown error
        // bubbling out of an unfamiliar fetch implementation.
      }
    }
    // Tier-3 fallback (continued): no profile.pulseId, OR the profile
    // pulseId didn't resolve. Use the streamer's own raw toon_handle —
    // forwarded by recent agent uploads on each game — to drive the
    // SC2Pulse character search. This rescues streamers who never
    // pasted a numeric pulseCharacterId into Settings (the common
    // case: the field is empty on a fresh install).
    if (
      mmrCurrent === undefined &&
      this.pulseMmr &&
      typeof this.pulseMmr.getCurrentMmrByToon === "function" &&
      lastKnownMyToonHandle
    ) {
      try {
        const pulse = await this.pulseMmr.getCurrentMmrByToon(
          lastKnownMyToonHandle,
        );
        if (pulse && Number.isFinite(pulse.mmr)) {
          mmrCurrent = pulse.mmr;
          mmrSource = "pulse_toon";
          if (typeof pulse.region === "string" && pulse.region) {
            pulseRegion = pulse.region;
          }
        }
      } catch {
        // Same fail-soft contract as the profile-pulseId branch above —
        // a SC2Pulse hiccup must never block the session payload from
        // emitting.
      }
    }
    if (mmrCurrent === undefined && mmrSource === "none") {
      mmrSource = "unresolved";
    }
    // One INFO line per todaySession resolve so an operator (or a
    // streamer who escalates) can grep the API log to see exactly why
    // the session widget paints "—". The cardinality is bounded by
    // (overlay sockets × ingest events × distinct timezones) so this
    // shouldn't dominate the log volume on a healthy instance.
    if (this.logger && typeof this.logger.info === "function") {
      try {
        this.logger.info(
          {
            event: "session_mmr_resolved",
            userId,
            mmrSource,
            mmrCurrent: mmrCurrent ?? null,
            hadPulseId: typeof profile.pulseId === "string" && !!profile.pulseId,
            hadMyToonHandle: !!lastKnownMyToonHandle,
            todayGames: games,
          },
          "session widget MMR resolution",
        );
      } catch {
        // A misbehaving logger must never block the session emit.
      }
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
    // Region resolution — explicit profile field wins, falls through to
    // the SC2Pulse-derived region (when Tier-3 fired), then to the
    // sticky-MMR-derived region the agent pinged with the rating, then
    // to the toon handle byte (1=NA, 2=EU, 3=KR, 5=CN, 6=SEA). The
    // session widget anchors its bottom-row layout on whatever we
    // surface here.
    if (typeof profile.region === "string" && profile.region) {
      out.region = profile.region.toUpperCase();
    }
    if (out.region === undefined && pulseRegion) {
      out.region = pulseRegion;
    }
    if (
      out.region === undefined &&
      typeof profile.lastKnownMmrRegion === "string" &&
      profile.lastKnownMmrRegion
    ) {
      out.region = profile.lastKnownMmrRegion.toUpperCase();
    }
    if (out.region === undefined && lastKnownToonHandle) {
      const inferred = regionFromToonHandle(lastKnownToonHandle);
      if (inferred) out.region = inferred;
    }
    return out;
  }
}

/**
 * Map the leading region byte of an SC2 toon handle to a short
 * Blizzard-region label. Returns ``null`` for unknown region ids so
 * the caller can leave ``region`` undefined (the renderer treats that
 * as "no region available").
 *
 * @param {string} toonHandle
 * @returns {string|null}
 */
function regionFromToonHandle(toonHandle) {
  if (typeof toonHandle !== "string") return null;
  const head = toonHandle.split("-")[0];
  switch (head) {
    case "1": return "NA";
    case "2": return "EU";
    case "3": return "KR";
    case "5": return "CN";
    case "6": return "SEA";
    default: return null;
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
