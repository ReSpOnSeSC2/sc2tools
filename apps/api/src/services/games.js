"use strict";

const { LIMITS, COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { HEAVY_FIELDS } = require("./gameDetails");
const { regionFromToonHandle } = require("../util/regionFromToonHandle");

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
   *     getCurrentMmrForAny?(
   *       ids: string[],
   *       opts?: { preferredRegion?: string },
   *     ): Promise<{
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
   * Distinct ``myToonHandle`` values across every game the user has
   * uploaded — i.e. every SC2 ladder identity the agent has seen them
   * play on. Used by the Settings → Profile UI to surface "auto-
   * detected" pulse IDs the user can one-click add to their profile,
   * and by the games-ingest path to backfill ``users.pulseIds``
   * automatically.
   *
   * Sorted by most-recent-use first so the streamer's currently-active
   * ladder identity is at the top of the suggestions list. Capped at
   * ``limit`` (default 20) to match the user-doc array bound.
   *
   * @param {string} userId
   * @param {number} [limit=20]
   * @returns {Promise<string[]>}
   */
  async distinctMyToonHandles(userId, limit = 20) {
    const pipeline = [
      {
        $match: {
          userId,
          myToonHandle: { $exists: true, $type: "string", $ne: "" },
        },
      },
      {
        $group: {
          _id: "$myToonHandle",
          lastSeen: { $max: "$date" },
        },
      },
      { $sort: { lastSeen: -1 } },
      { $limit: Math.max(1, Math.min(limit, 50)) },
    ];
    const rows = await this.db.games.aggregate(pipeline).toArray();
    return rows
      .map((r) => (typeof r._id === "string" ? r._id.trim() : ""))
      .filter((s) => s.length > 0);
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
    /** @type {string|undefined} */
    let lastKnownMmrToonHandle;
    /** @type {Array<'win'|'loss'>} */
    const todayResults = [];
    for (const row of rows) {
      const date = row.date instanceof Date ? row.date : new Date(row.date);
      if (Number.isNaN(date.getTime())) continue;
      const my = Number(row.myMmr);
      const myToon = row.myToonHandle;
      // Track the most recent known MMR across the whole window so the
      // session widget can render a meaningful number even on days
      // where the streamer hasn't queued yet. Rows are pre-sorted asc
      // so the last assignment wins. Snap the row's myToonHandle alongside
      // so the region label downstream matches the MMR source — without
      // this, a multi-region streamer whose latest game is on NA but
      // whose latest MMR-bearing game was on EU would see "NA <EU MMR>".
      if (Number.isFinite(my)) {
        lastKnownMmr = my;
        if (typeof myToon === "string" && myToon.length > 0) {
          lastKnownMmrToonHandle = myToon;
        }
      }
      const toon = row.opponent && row.opponent.toonHandle;
      if (typeof toon === "string" && toon.length > 0) {
        lastKnownToonHandle = toon;
      }
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
     *   ``pulse_multi``     — SC2Pulse queried with the union of every
     *                         id on the streamer's profile (``pulseIds``
     *                         array + the legacy single-string ``pulseId``
     *                         + the most recent game's ``myToonHandle``)
     *                         in one batched call; the most-recently-
     *                         played team across the union wins.
     *   ``pulse_pulseid`` / ``pulse_toon`` — single-id legacy paths.
     *                         Only fire when the injected pulseMmr
     *                         service hasn't been upgraded to
     *                         ``getCurrentMmrForAny`` (older unit-test
     *                         stubs); production always takes the
     *                         ``pulse_multi`` branch.
     *   ``unresolved``      — every tier missed; widget paints ``—``.
     *
     * @type {'games_today'|'games_window'|'games_anytime'|'profile_sticky'|'pulse_multi'|'pulse_pulseid'|'pulse_toon'|'unresolved'|'none'}
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
     *   pulseIds?: string[],
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
    // Build the union of every pulse identifier we know about for this
    // user: every chip from ``users.pulseIds`` (multi-region accounts,
    // historical toons), the legacy single-string ``pulseId`` field
    // (mirrored to ``pulseIds[0]`` but kept for unmigrated docs), and
    // the streamer's own ``myToonHandle`` from the most recent game
    // (so a streamer who has zero saved chips still resolves).
    /** @type {string[]} */
    const pulseIdsUnion = [];
    const pulseIdsSeen = new Set();
    /** @type {(raw: unknown) => void} */
    const pushPulseId = (raw) => {
      if (typeof raw !== "string") return;
      const trimmed = raw.trim();
      if (!trimmed || pulseIdsSeen.has(trimmed)) return;
      pulseIdsSeen.add(trimmed);
      pulseIdsUnion.push(trimmed);
    };
    if (Array.isArray(profile.pulseIds)) {
      for (const id of profile.pulseIds) pushPulseId(id);
    }
    pushPulseId(profile.pulseId);
    pushPulseId(lastKnownMyToonHandle);
    // Pin SC2Pulse's region selection to wherever the streamer actually
    // played most recently. The toon-handle byte from the most recent
    // game (1=NA, 2=EU, 3=KR/TW, 5=CN, 6=SEA) is the strongest signal
    // — it's "where the last replay landed" — and stops a multi-region
    // profile from pinning to a stale account on the wrong ladder when
    // SC2Pulse's lastPlayed for that account happens to be more recent
    // than the streamer's current grind. Profile.region (what the user
    // typed into Settings) is the next-best fallback. As a last resort
    // before letting SC2Pulse's global lastPlayed sort decide, we scan
    // the user's pulseIds union for any toon-handle entry — that gives
    // a cold-start lookup (right after API restart, no recent game seen
    // yet) a region anchor instead of letting a long-stale KR account
    // win on raw timestamp.
    /** @type {string|undefined} */
    let preferredRegion;
    if (lastKnownMyToonHandle) {
      const inferred = regionFromToonHandle(lastKnownMyToonHandle);
      if (inferred) preferredRegion = inferred;
    }
    if (!preferredRegion && typeof profile.region === "string" && profile.region) {
      preferredRegion = normaliseRegionLabel(profile.region);
    }
    if (!preferredRegion) {
      for (const candidate of pulseIdsUnion) {
        const inferred = regionFromToonHandle(candidate);
        if (inferred) {
          preferredRegion = inferred;
          break;
        }
      }
    }
    // Tier-3 fallback: still no MMR after walking every game we have.
    // Hit SC2Pulse for the user's current 1v1 ladder rating with the
    // FULL union of saved + auto-detected pulse ids in a single batched
    // call. The service picks whichever team SC2Pulse says was played
    // most recently across the entire union, biased to the streamer's
    // last-played region — so a multi-region streamer who pasted a NA
    // toon plus two stale numeric chips still sees "NA 5377" when their
    // most recent replay was on NA, instead of "KR 5377" because some
    // other Pulse account on KR was touched yesterday.
    if (
      mmrCurrent === undefined &&
      this.pulseMmr &&
      typeof this.pulseMmr.getCurrentMmrForAny === "function" &&
      pulseIdsUnion.length > 0
    ) {
      try {
        const pulse = await this.pulseMmr.getCurrentMmrForAny(
          pulseIdsUnion,
          preferredRegion ? { preferredRegion } : undefined,
        );
        if (pulse && Number.isFinite(pulse.mmr)) {
          mmrCurrent = pulse.mmr;
          mmrSource = "pulse_multi";
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
    // Legacy single-id fallback: only fires when the injected pulseMmr
    // service is a slim test stub that doesn't expose the new
    // ``getCurrentMmrForAny`` API. Production always takes the multi-id
    // branch above; this preserves the contract for older tests that
    // mock just the single-id methods.
    if (
      mmrCurrent === undefined &&
      this.pulseMmr &&
      typeof this.pulseMmr.getCurrentMmrForAny !== "function" &&
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
        // Best-effort — same fail-soft contract.
      }
    }
    if (
      mmrCurrent === undefined &&
      this.pulseMmr &&
      typeof this.pulseMmr.getCurrentMmrForAny !== "function" &&
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
            pulseIdsCount: pulseIdsUnion.length,
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
    // Region resolution — walks from "most authoritative for the
    // displayed MMR" down to "least authoritative" so the widget never
    // paints a region label that contradicts the MMR source. Earlier
    // versions put profile.region (the Settings dropdown) at the top,
    // which let a stale "kr" preference paint over an obviously-NA
    // play once SC2Pulse had already returned the NA team's rating —
    // streamers saw "KR 5326" with their NA MMR. profile.region is
    // still consulted, just as a fallback hint when no actual-play
    // signal is available.
    //
    //   1. pulseRegion — when SC2Pulse fired (any pulse_* tier), this
    //      IS the region of the team whose MMR we're displaying. The
    //      MMR and region come back as a pair; splitting them lets the
    //      widget lie.
    //   2. lastKnownMmrToonHandle — when MMR came from a stored game,
    //      the toon handle of THAT specific row is the source of truth.
    //      A multi-region streamer's stored myMmr belongs to a specific
    //      account, not "the most recent game" generically.
    //   3. profile.lastKnownMmrRegion — when MMR came from the agent's
    //      sticky-MMR ping, it stamped the region alongside.
    //   4. lastKnownMyToonHandle — most recent game's region, even if
    //      that row didn't carry MMR. Better than profile.region as a
    //      fallback because it reflects current play, not a setting
    //      typed in months ago.
    //   5. profile.region — user's Settings dropdown. Final fallback.
    //   6. lastKnownToonHandle — opponent's toon handle. Last resort,
    //      since the opponent and streamer aren't always on the same
    //      ladder (cross-region matchmaking, custom games).
    if (pulseRegion) {
      out.region = pulseRegion;
    }
    if (out.region === undefined && lastKnownMmrToonHandle) {
      const inferred = regionFromToonHandle(lastKnownMmrToonHandle);
      if (inferred) out.region = inferred;
    }
    if (
      out.region === undefined &&
      typeof profile.lastKnownMmrRegion === "string" &&
      profile.lastKnownMmrRegion
    ) {
      out.region = normaliseRegionLabel(profile.lastKnownMmrRegion);
    }
    if (out.region === undefined && lastKnownMyToonHandle) {
      const inferred = regionFromToonHandle(lastKnownMyToonHandle);
      if (inferred) out.region = inferred;
    }
    if (out.region === undefined && typeof profile.region === "string" && profile.region) {
      out.region = normaliseRegionLabel(profile.region);
    }
    if (out.region === undefined && lastKnownToonHandle) {
      const inferred = regionFromToonHandle(lastKnownToonHandle);
      if (inferred) out.region = inferred;
    }
    return out;
  }
}

/**
 * Normalise a region string into the canonical Blizzard-region label
 * (``NA`` / ``EU`` / ``KR`` / ``CN`` / ``SEA``) the rest of the session
 * widget pipeline uses. The Settings dropdown stores ``us`` / ``eu`` /
 * ``kr`` / ``cn`` (Battle.net subdomain convention), the agent ping
 * stamps whatever the toon-handle inference returned, and SC2Pulse
 * returns its own labels — without this mapping the widget can paint
 * "US 5326" alongside an "NA"-derived MMR. Anything we don't recognise
 * is upper-cased and returned as-is so a future region (or an upstream
 * label we haven't enumerated yet) still renders something rather than
 * vanishing.
 *
 * @param {string} raw
 * @returns {string}
 */
function normaliseRegionLabel(raw) {
  const upper = String(raw).trim().toUpperCase();
  if (upper === "US") return "NA";
  return upper;
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
