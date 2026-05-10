"use strict";

const { LIMITS, COLLECTIONS } = require("../config/constants");
const { hmac } = require("../util/hash");
const { expectedVersion } = require("../db/schemaVersioning");
const { gamesMatchStage } = require("../util/parseQuery");
const { opponentGamesFilter } = require("../util/opponentIdentity");
const TimingCatalog = require("./timingCatalog");
const Dna = require("./dnaTimings");

const OPPONENTS_VERSION = expectedVersion(COLLECTIONS.OPPONENTS);

const PROFILE_GAME_PROJECTION = {
  _id: 0,
  gameId: 1,
  date: 1,
  result: 1,
  map: 1,
  myRace: 1,
  myBuild: 1,
  durationSec: 1,
  macroScore: 1,
  apm: 1,
  spq: 1,
  buildLog: 1,
  oppBuildLog: 1,
  // earlyBuildLog / oppEarlyBuildLog deliberately omitted: dnaTimings
  // (the only consumer of game payloads from this projection) reads
  // only the full ``buildLog`` / ``oppBuildLog`` fields. Skipping the
  // early arrays here used to load ~6 kB of redundant data per profile
  // game; v0.4.3+ agents stop emitting them entirely and pre-v0.4.3
  // docs still derive correctly from the full log when a service
  // actually needs the early window (see ``readEarlyBuildLog`` in
  // perGameCompute).
  opponent: 1,
};

/**
 * Opponents service. One document per (userId, pulseId).
 *
 * Storage shape:
 *   {
 *     userId, pulseId,
 *     displayNameHash, displayNameSample,  // HMAC + last seen plaintext
 *     race, mmr, leagueId,
 *     gameCount, wins, losses,
 *     firstSeen, lastSeen,
 *     openings: { "Pool first": 3, ... }   // small frequency map
 *   }
 *
 * Display name is hashed for cross-user lookup; the sample is shown
 * back to the SAME owning user only.
 */
class OpponentsService {
  /**
   * @param {{opponents: import('mongodb').Collection, games: import('mongodb').Collection}} db
   * @param {Buffer} pepper
   * @param {{ gameDetails?: import('./gameDetails').GameDetailsService }} [opts]
   *        When provided, the profile loader hydrates ``buildLog`` /
   *        ``oppBuildLog`` from the detail store for any game whose
   *        slim row no longer carries them inline (post-cutover
   *        cleanup migration). Without it, profiles serve only legacy
   *        inline data — which is the safe default during tests that
   *        don't exercise the detail-store path.
   */
  constructor(db, pepper, opts = {}) {
    this.db = db;
    this.pepper = pepper;
    this.gameDetails = opts.gameDetails || null;
    // Optional pino logger. Used for the structured "pulseCharacterId
    // upgraded" / "backfill cycle" lines. Falls back to a no-op
    // shim so unit tests that construct the service without a logger
    // (the bulk of the existing suite) keep working untouched.
    this.logger = opts.logger || NOOP_LOGGER;
    // Server-side SC2Pulse resolver — same toon → character-id
    // contract as the agent's resolver, but invoked from the
    // backfill cron (and any other cloud path that needs to recover
    // a missing pulseCharacterId after the fact). Optional in unit
    // tests that don't exercise backfill; ``backfillPulseCharacterId``
    // throws if asked to run without one.
    this.pulseResolver = opts.pulseResolver || null;
  }

  /**
   * Page through a user's opponents, newest activity first.
   *
   * When `filters` is provided (since/until/race/oppRace/map/mmr/etc.),
   * the lifetime counters stored on the opponents collection don't
   * apply — totals get re-aggregated from the games collection within
   * the filter window, and any opponent without a single qualifying
   * game is dropped from the result.
   *
   * @param {string} userId
   * @param {{
   *   limit?: number,
   *   before?: Date,
   *   filters?: ReturnType<typeof gamesMatchStage>['__filters'] & object,
   * }} [opts]
   * @returns {Promise<{items: object[], nextBefore: Date|null}>}
   */
  async list(userId, opts = {}) {
    const filters = opts.filters || {};
    const filtered = hasFilters(filters);
    if (filtered) {
      return this._listFiltered(userId, filters, opts);
    }
    const limit = clampLimit(opts.limit, LIMITS.OPPONENTS_PAGE_SIZE);
    /** @type {Record<string, any>} */
    const filter = { userId };
    if (opts.before instanceof Date && !Number.isNaN(opts.before.getTime())) {
      filter.lastSeen = { $lt: opts.before };
    }
    const items = await this.db.opponents
      .find(filter, { projection: { _id: 0 } })
      .sort({ lastSeen: -1 })
      .limit(limit + 1)
      .toArray();
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextBefore = hasMore ? page[page.length - 1].lastSeen : null;
    return { items: page, nextBefore };
  }

  /**
   * Aggregate the opponents list from the games collection within a
   * filter window. Used when the user picks a date range / matchup /
   * map / MMR slice — we can't trust the cumulative counters on the
   * opponents collection in that case.
   *
   * @private
   * @param {string} userId
   * @param {object} filters
   * @param {{limit?: number, before?: Date}} opts
   */
  async _listFiltered(userId, filters, opts) {
    const limit = clampLimit(opts.limit, LIMITS.OPPONENTS_PAGE_SIZE);
    const match = gamesMatchStage(userId, filters);
    // Rolling cursor: opponents whose lastPlayed-in-window is older
    // than `before`. This is post-aggregation so we re-apply it as a
    // $match after the per-pulse rollup.
    const cursorMatch = {};
    if (opts.before instanceof Date && !Number.isNaN(opts.before.getTime())) {
      cursorMatch.lastPlayed = { $lt: opts.before };
    }

    const pipeline = [
      { $match: match },
      { $match: { "opponent.pulseId": { $type: "string", $ne: "" } } },
      {
        $group: {
          _id: "$opponent.pulseId",
          wins: {
            $sum: {
              $cond: [
                { $in: [{ $toLower: { $ifNull: ["$result", ""] } }, ["victory", "win"]] },
                1,
                0,
              ],
            },
          },
          losses: {
            $sum: {
              $cond: [
                { $in: [{ $toLower: { $ifNull: ["$result", ""] } }, ["defeat", "loss"]] },
                1,
                0,
              ],
            },
          },
          gameCount: { $sum: 1 },
          firstPlayed: { $min: "$date" },
          lastPlayed: { $max: "$date" },
          displayNameSample: { $last: { $ifNull: ["$opponent.displayName", ""] } },
          race: { $last: { $ifNull: ["$opponent.race", ""] } },
          mmr: { $last: { $ifNull: ["$opponent.mmr", null] } },
          leagueId: { $last: { $ifNull: ["$opponent.leagueId", null] } },
          toonHandle: { $last: { $ifNull: ["$opponent.toonHandle", null] } },
          pulseCharacterId: { $last: { $ifNull: ["$opponent.pulseCharacterId", null] } },
        },
      },
      {
        $project: {
          _id: 0,
          pulseId: "$_id",
          wins: 1,
          losses: 1,
          gameCount: 1,
          firstSeen: "$firstPlayed",
          lastSeen: "$lastPlayed",
          lastPlayed: "$lastPlayed",
          displayNameSample: 1,
          race: 1,
          mmr: 1,
          leagueId: 1,
          toonHandle: 1,
          pulseCharacterId: 1,
          winRate: {
            $cond: [
              { $gt: [{ $add: ["$wins", "$losses"] }, 0] },
              { $divide: ["$wins", { $add: ["$wins", "$losses"] }] },
              0,
            ],
          },
        },
      },
    ];
    if (Object.keys(cursorMatch).length > 0) {
      pipeline.push({ $match: cursorMatch });
    }
    pipeline.push({ $sort: { lastPlayed: -1 } });
    pipeline.push({ $limit: limit + 1 });

    const items = await this.db.games.aggregate(pipeline).toArray();
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextBefore = hasMore ? page[page.length - 1].lastPlayed : null;
    // Backfill identity fields the games-aggregation can't see.
    //
    // ``_listFiltered`` aggregates from the games collection because
    // the cumulative counters on the opponents collection don't apply
    // inside a filter window. The aggregation pulls
    // ``pulseCharacterId`` / ``toonHandle`` off the embedded opponent
    // sub-doc on the most recent game (``$last``) — but those fields
    // are only stamped onto a games row at the moment of upload.
    //
    // The May-2026 backfill cron heals the opponents COLLECTION row
    // for stuck-on-TOON opponents by writing the canonical
    // pulseCharacterId there directly; it does NOT rewrite historical
    // games rows (we keep games immutable). For an opponent whose
    // games all pre-date the heal, ``$last`` returns null even
    // though the opponents row holds the canonical id, so the SPA
    // table cell falls back to the toon-handle "TOON" badge while
    // the profile (which reads the opponents row directly) renders
    // the link. Confusing.
    //
    // Patch the gap with a single batched ``find`` against the
    // opponents collection: for every row whose aggregation produced
    // null, splice in the canonical value if the row has it. Sticky-
    // empty semantics preserved: a non-null aggregation value is
    // never overwritten — the games rows are still the authority on
    // the most-recent observed identity.
    await this._fillIdentityFromOpponents(userId, page);
    return { items: page, nextBefore };
  }

  /**
   * In-place fill of missing ``pulseCharacterId`` / ``toonHandle`` on
   * an aggregation result page. One ``find`` round-trip regardless of
   * page size (uses the existing ``{ userId, pulseId }`` unique index
   * for an index scan).
   *
   * No-op when every row already carries both fields. Safe on an
   * empty page.
   *
   * @private
   * @param {string} userId
   * @param {Array<{
   *   pulseId: string,
   *   pulseCharacterId?: string|null,
   *   toonHandle?: string|null,
   * }>} rows
   */
  async _fillIdentityFromOpponents(userId, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const needIds = [];
    for (const r of rows) {
      if (!r || typeof r.pulseId !== "string") continue;
      const missingChar = !r.pulseCharacterId;
      const missingToon = !r.toonHandle;
      if (missingChar || missingToon) needIds.push(r.pulseId);
    }
    if (needIds.length === 0) return;
    const opponentsCursor = this.db.opponents.find(
      { userId, pulseId: { $in: needIds } },
      { projection: { _id: 0, pulseId: 1, pulseCharacterId: 1, toonHandle: 1 } },
    );
    /** @type {Map<string, {pulseCharacterId?: string, toonHandle?: string}>} */
    const byPulseId = new Map();
    for await (const doc of opponentsCursor) {
      if (typeof doc.pulseId !== "string") continue;
      byPulseId.set(doc.pulseId, {
        pulseCharacterId: typeof doc.pulseCharacterId === "string"
          ? doc.pulseCharacterId
          : undefined,
        toonHandle: typeof doc.toonHandle === "string"
          ? doc.toonHandle
          : undefined,
      });
    }
    for (const r of rows) {
      if (!r || typeof r.pulseId !== "string") continue;
      const opp = byPulseId.get(r.pulseId);
      if (!opp) continue;
      if (!r.pulseCharacterId && opp.pulseCharacterId) {
        r.pulseCharacterId = opp.pulseCharacterId;
      }
      if (!r.toonHandle && opp.toonHandle) {
        r.toonHandle = opp.toonHandle;
      }
    }
  }

  /**
   * Build the full opponent profile payload consumed by the SPA's
   * `OpponentProfile` view: totals, byMap, byStrategy, top strategies,
   * recency-weighted predictions, matchup-aware median timings (overall
   * + per matchup), last 5 games, and the full games array (newest
   * first) for the all-games table.
   *
   * Date-range filtering: when `opts.since` / `opts.until` are provided,
   * totals / byMap / byStrategy / topStrategies / median + matchup
   * timings / matchup counts / the all-games table are computed from
   * the games inside the window. `last5Games` and `predictedStrategies`
   * always come from the unfiltered (full-history) games list, since the
   * UI surfaces them as "what's likely next" and "most recent activity"
   * — both of which would be misleading if scoped to a stale window.
   *
   * @param {string} userId
   * @param {string} pulseId
   * @param {{ since?: Date, until?: Date }} [opts]
   */
  async get(userId, pulseId, opts = {}) {
    const doc = await this.db.opponents.findOne(
      { userId, pulseId },
      { projection: { _id: 0 } },
    );
    if (!doc) return null;
    // Match games against either identity field. The opponents row
    // stores the canonical SC2Pulse character id; if a player ever
    // rebound their Battle.net (rotating the toon_handle while
    // keeping the SC2Pulse character identity), pre-rebind games
    // would otherwise drop out of this profile because they carry
    // the OLD pulseId. Falls back to pulseId-only when the row
    // hasn't been resolved yet (the backfill cron will heal it on
    // its next cycle).
    const idsFilter = opponentGamesFilter({
      pulseId,
      pulseCharacterId: doc.pulseCharacterId,
    });
    const gamesFilter = idsFilter
      ? { userId, ...idsFilter }
      : { userId, "opponent.pulseId": pulseId };
    const rawGames = await this.db.games
      .find(gamesFilter, { projection: PROFILE_GAME_PROJECTION })
      .sort({ date: -1 })
      .toArray();
    // dnaTimings reads ``buildLog`` / ``oppBuildLog`` off each game
    // object to compute first-occurrence-of-token timings. After the
    // v0.4.3 cutover those arrays move to the detail store; bulk-fetch
    // them here so ``serializeGameForProfile`` sees a hydrated game.
    // The fetch is one batched query regardless of how many games the
    // opponent profile spans, so the per-profile cost is constant.
    if (this.gameDetails && rawGames.length > 0) {
      const needIds = [];
      for (const g of rawGames) {
        if (!Array.isArray(g.buildLog) || !Array.isArray(g.oppBuildLog)) {
          if (g.gameId) needIds.push(String(g.gameId));
        }
      }
      if (needIds.length > 0) {
        const blobs = await this.gameDetails.findMany(userId, needIds);
        for (const g of rawGames) {
          const blob = blobs.get(String(g.gameId || ""));
          if (!blob) continue;
          if (!Array.isArray(g.buildLog) && Array.isArray(blob.buildLog)) {
            g.buildLog = blob.buildLog;
          }
          if (!Array.isArray(g.oppBuildLog) && Array.isArray(blob.oppBuildLog)) {
            g.oppBuildLog = blob.oppBuildLog;
          }
        }
      }
    }
    const allGames = rawGames.map(serializeGameForProfile);
    const filteredGames = filterGamesByDate(allGames, opts.since, opts.until);
    // Cross-toon merge surfacing: if the rawGames span multiple toon
    // handles (the Battle.net rebind case), expose the merged set so
    // the SPA can render a "merged across N toons" disclosure chip
    // without needing a second round-trip. Single-toon profiles
    // omit this field entirely so the UI shows nothing extra.
    const mergedToonHandles = collectMergedToonHandles(rawGames, doc);
    const aggregates = aggregateByMapAndStrategy(filteredGames);
    const totals = computeTotals(filteredGames, doc);
    const dna = computeDnaFields(filteredGames);
    // Predictions and the most-recent-5 list always reflect the full
    // history — see method jsdoc.
    const predictedStrategies = Dna.recencyWeightedStrategies(allGames);
    const last5Games = allGames.slice(0, 5);
    const matchupTimingsLegacy = dna.matchupTimings;
    const matchupTimings = projectMatchupTimings(matchupTimingsLegacy);
    return {
      ...doc,
      name: doc.displayNameSample || "",
      mergedToonHandles,
      totals,
      byMap: aggregates.byMap,
      byStrategy: aggregates.byStrategy,
      topStrategies: dna.topStrategies,
      predictedStrategies,
      myRace: dna.myRace,
      oppRaceModal: dna.oppRaceModal,
      matchupLabel: dna.matchupLabel,
      matchupCounts: dna.matchupCounts,
      matchupTimings,
      matchupTimingsLegacy,
      medianTimings: projectMedianTimings(dna.medianTimings),
      medianTimingsLegacy: dna.medianTimings,
      medianTimingsOrder: dna.medianTimingsOrder,
      last5Games,
      games: filteredGames,
    };
  }

  /**
   * Upsert from a parsed game. Aggregates win/loss + opening counts.
   *
   * @param {string} userId
   * @param {{
   *   pulseId: string,
   *   toonHandle?: string,
   *   pulseCharacterId?: string,
   *   displayName: string,
   *   race: string,
   *   mmr?: number,
   *   leagueId?: number,
   *   result: 'Victory'|'Defeat'|'Tie',
   *   opening?: string,
   *   playedAt: Date,
   * }} game
   */
  async recordGame(userId, game) {
    if (!game.pulseId) throw new Error("pulseId required");
    const displayHash = hmac(this.pepper, game.displayName || "");
    const winInc = game.result === "Victory" ? 1 : 0;
    const lossInc = game.result === "Defeat" ? 1 : 0;
    // Read the prior row first so we can log a structured change
    // line when a fresh pulseCharacterId replaces a stale one. The
    // single $setOnInsert/$set/$inc upsert below stays atomic — the
    // pre-read is for telemetry only and a missing prior row is
    // expected on the first encounter.
    const prior = await this.db.opponents.findOne(
      { userId, pulseId: game.pulseId },
      { projection: { pulseCharacterId: 1 } },
    );
    /** @type {Record<string, any>} */
    const setOnInsert = {
      userId,
      pulseId: game.pulseId,
      firstSeen: game.playedAt,
    };
    /** @type {Record<string, any>} */
    const set = {
      displayNameHash: displayHash,
      displayNameSample: game.displayName || "",
      race: game.race,
      lastSeen: game.playedAt,
      _schemaVersion: OPPONENTS_VERSION,
    };
    if (typeof game.mmr === "number") set.mmr = game.mmr;
    if (typeof game.leagueId === "number") set.leagueId = game.leagueId;
    // Identity: persist the raw toon_handle (always present from
    // sc2reader) and the resolved sc2pulse.nephest.com character id
    // when available.
    //
    // Sticky semantics on pulseCharacterId:
    //   * Never overwrite with an empty value — once resolved the
    //     row stays linked, so an offline catch-up scan after the
    //     first game doesn't blank the link.
    //   * DO overwrite when the incoming non-empty value differs
    //     from the stored one. SC2Pulse occasionally rotates the
    //     canonical character id when an account is re-linked; we
    //     trust the latest non-empty resolution and log the change
    //     so the swap is auditable.
    if (typeof game.toonHandle === "string" && game.toonHandle.length > 0) {
      set.toonHandle = game.toonHandle;
    }
    let pulseCharIdChange = null;
    if (
      typeof game.pulseCharacterId === "string"
      && game.pulseCharacterId.length > 0
    ) {
      set.pulseCharacterId = game.pulseCharacterId;
      const before = prior && typeof prior.pulseCharacterId === "string"
        ? prior.pulseCharacterId
        : null;
      if (before !== game.pulseCharacterId) {
        pulseCharIdChange = { from: before, to: game.pulseCharacterId };
      }
    }
    // Stamp the resolve-attempt timestamp whenever the agent (or any
    // ingest source) tells us it tried. Used by the backfill cron's
    // "skip rows attempted within window" guard so two services can
    // coordinate without one starving the other of retries.
    if (game.pulseLookupAttempted === true) {
      set.pulseResolveAttemptedAt = new Date();
    }
    /** @type {Record<string, any>} */
    const inc = { gameCount: 1, wins: winInc, losses: lossInc };
    if (game.opening && game.opening.length > 0) {
      const key = `openings.${sanitizeKey(game.opening)}`;
      inc[key] = 1;
    }
    await this.db.opponents.updateOne(
      { userId, pulseId: game.pulseId },
      { $setOnInsert: setOnInsert, $set: set, $inc: inc },
      { upsert: true },
    );
    if (pulseCharIdChange) {
      this.logger.info(
        {
          userId,
          pulseId: game.pulseId,
          from: pulseCharIdChange.from,
          to: pulseCharIdChange.to,
        },
        "opponent_pulse_character_id_upgraded",
      );
    }
    return {
      upgraded: Boolean(pulseCharIdChange),
      from: pulseCharIdChange ? pulseCharIdChange.from : null,
      to: pulseCharIdChange ? pulseCharIdChange.to : null,
    };
  }

  /**
   * Refresh the per-opponent metadata fields that legitimately drift
   * between encounters (display name, MMR, league, identity link,
   * lastSeen) WITHOUT touching any counter. Called from the games
   * ingest path on a re-upload — i.e. when the slim row already
   * existed in ``games`` and ``recordGame``'s $inc would otherwise
   * double-count gameCount / wins / losses / openings.
   *
   * Public companion of ``recordGame``: same input shape minus the
   * fields that drive counters (result, opening). Idempotent — every
   * re-upload of the same game produces the same write.
   *
   * @param {string} userId
   * @param {{
   *   pulseId: string,
   *   toonHandle?: string,
   *   pulseCharacterId?: string,
   *   displayName?: string,
   *   race: string,
   *   mmr?: number,
   *   leagueId?: number,
   *   playedAt: Date,
   * }} game
   */
  async refreshMetadata(userId, game) {
    if (!game.pulseId) throw new Error("pulseId required");
    const prior = await this.db.opponents.findOne(
      { userId, pulseId: game.pulseId },
      { projection: { pulseCharacterId: 1 } },
    );
    /** @type {Record<string, any>} */
    const set = {
      displayNameHash: hmac(this.pepper, game.displayName || ""),
      displayNameSample: game.displayName || "",
      race: game.race,
      lastSeen: game.playedAt,
      _schemaVersion: OPPONENTS_VERSION,
    };
    if (typeof game.mmr === "number") set.mmr = game.mmr;
    if (typeof game.leagueId === "number") set.leagueId = game.leagueId;
    if (typeof game.toonHandle === "string" && game.toonHandle.length > 0) {
      set.toonHandle = game.toonHandle;
    }
    let pulseCharIdChange = null;
    if (
      typeof game.pulseCharacterId === "string"
      && game.pulseCharacterId.length > 0
    ) {
      set.pulseCharacterId = game.pulseCharacterId;
      const before = prior && typeof prior.pulseCharacterId === "string"
        ? prior.pulseCharacterId
        : null;
      if (before !== game.pulseCharacterId) {
        pulseCharIdChange = { from: before, to: game.pulseCharacterId };
      }
    }
    if (game.pulseLookupAttempted === true) {
      set.pulseResolveAttemptedAt = new Date();
    }
    // updateOne (NOT upsert: true) — we only refresh rows that
    // already exist. If the opponent row is missing entirely, the
    // ingest path's ``created`` check already determined this was
    // not a new-game ingest and any earlier insert was lost; the
    // admin "Rebuild opponents" tool reconstructs from games.
    const res = await this.db.opponents.updateOne(
      { userId, pulseId: game.pulseId },
      { $set: set },
    );
    if (pulseCharIdChange) {
      this.logger.info(
        {
          userId,
          pulseId: game.pulseId,
          from: pulseCharIdChange.from,
          to: pulseCharIdChange.to,
        },
        "opponent_pulse_character_id_upgraded",
      );
    }
    return {
      matched: res.matchedCount || 0,
      modified: res.modifiedCount || 0,
      upgraded: Boolean(pulseCharIdChange),
    };
  }

  /**
   * Find opponent rows belonging to ``userId`` whose
   * ``pulseCharacterId`` is missing or empty AND whose
   * ``toonHandle`` is set, then attempt to resolve each one against
   * SC2Pulse. Successful resolutions are persisted; misses bump
   * ``pulseResolveAttemptedAt`` so we don't re-hit Pulse on every
   * subsequent tick.
   *
   * Two cooperating bounds:
   *   * ``opts.limit`` (default 50) caps how many rows one cycle
   *     touches, keeping a single backfill tick cheap.
   *   * ``opts.maxAgeSec`` (default 6h) skips rows attempted within
   *     that window — together with the per-row
   *     ``pulseResolveAttemptedAt`` stamp this prevents the cron
   *     from hammering SC2Pulse for an opponent that was just
   *     probed (e.g. by the agent on a fresh upload).
   *
   * Returns counters so the caller (cron job, admin rebuild) can
   * log a structured one-line summary.
   *
   * @param {string} userId
   * @param {{
   *   limit?: number,
   *   maxAgeSec?: number,
   *   force?: boolean,
   * }} [opts]
   * @returns {Promise<{
   *   scanned: number,
   *   resolved: number,
   *   updated: number,
   *   skipped: number,
   * }>}
   */
  async backfillPulseCharacterId(userId, opts = {}) {
    if (!userId) throw new Error("userId required");
    if (!this.pulseResolver) {
      throw new Error(
        "OpponentsService.backfillPulseCharacterId requires a pulseResolver dependency",
      );
    }
    const limit = clampLimit(opts.limit, 50);
    const maxAgeSec = typeof opts.maxAgeSec === "number" && opts.maxAgeSec >= 0
      ? opts.maxAgeSec
      : 6 * 60 * 60;
    const cutoff = new Date(Date.now() - maxAgeSec * 1000);
    /** @type {Record<string, any>} */
    const filter = {
      userId,
      $or: [
        { pulseCharacterId: { $exists: false } },
        { pulseCharacterId: "" },
        { pulseCharacterId: null },
      ],
      toonHandle: { $type: "string", $ne: "" },
    };
    if (!opts.force) {
      filter.$and = [
        {
          $or: [
            { pulseResolveAttemptedAt: { $exists: false } },
            { pulseResolveAttemptedAt: null },
            { pulseResolveAttemptedAt: { $lt: cutoff } },
          ],
        },
      ];
    }
    const rows = await this.db.opponents
      .find(filter, {
        projection: {
          _id: 0,
          pulseId: 1,
          toonHandle: 1,
          displayNameSample: 1,
        },
      })
      .limit(limit)
      .toArray();
    let resolved = 0;
    let updated = 0;
    let skipped = 0;
    for (const row of rows) {
      const toon = typeof row.toonHandle === "string" ? row.toonHandle : "";
      if (!toon) {
        skipped += 1;
        continue;
      }
      const displayName = typeof row.displayNameSample === "string"
        ? row.displayNameSample
        : "";
      // Real outbound HTTP — no mocks, no synthetic ids. The
      // resolver swallows transient errors and returns null on
      // miss; all bookkeeping (positive/negative caching, retries,
      // rate-limit backoff) lives there.
      let pulseCharacterId = null;
      try {
        pulseCharacterId = await this.pulseResolver.resolve({
          toonHandle: toon,
          displayName,
          forceRefresh: true,
        });
      } catch (err) {
        this.logger.warn(
          { err, userId, pulseId: row.pulseId, toonHandle: toon },
          "opponent_pulse_backfill_resolver_failed",
        );
      }
      const now = new Date();
      const set = {
        pulseResolveAttemptedAt: now,
      };
      if (typeof pulseCharacterId === "string" && pulseCharacterId.length > 0) {
        set.pulseCharacterId = pulseCharacterId;
        resolved += 1;
      }
      const res = await this.db.opponents.updateOne(
        { userId, pulseId: row.pulseId },
        { $set: set },
      );
      if (res.modifiedCount > 0) updated += 1;
      if (typeof pulseCharacterId === "string" && pulseCharacterId.length > 0) {
        this.logger.info(
          {
            userId,
            pulseId: row.pulseId,
            from: null,
            to: pulseCharacterId,
            source: "backfill",
          },
          "opponent_pulse_character_id_upgraded",
        );
      }
    }
    return { scanned: rows.length, resolved, updated, skipped };
  }
}

const NOOP_LOGGER = {
  // Pino-shaped no-op logger so call sites can pass arbitrary log
  // shapes without a runtime check.
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => NOOP_LOGGER,
};

/**
 * Mongo field paths cannot contain '.', '$', or null bytes. Strip.
 *
 * @param {string} raw
 * @returns {string}
 */
function sanitizeKey(raw) {
  return String(raw).replace(/[.$ ]/g, "_");
}

/**
 * Cap at the configured page size by default. Callers that explicitly
 * pass a higher limit (the analyzer SPA fetching a complete table) can
 * go up to OPPONENTS_LIST_MAX before hitting the hard ceiling.
 *
 * @param {unknown} raw
 * @param {number} fallback
 * @returns {number}
 */
function clampLimit(raw, fallback) {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const ceiling = LIMITS.OPPONENTS_LIST_MAX || fallback;
  return Math.min(n, ceiling);
}

/** True if any of the standard filter fields are set. */
function hasFilters(f) {
  if (!f || typeof f !== "object") return false;
  return Boolean(
    f.since
      || f.until
      || f.race
      || f.oppRace
      || f.map
      || typeof f.mmrMin === "number"
      || typeof f.mmrMax === "number"
      || f.oppStrategy
      || f.build,
  );
}

/**
 * Normalise a stored game document into the shape consumed by the
 * legacy SPA profile renderers (lowercase ISO date string,
 * `opp_strategy`, `opp_race`, `my_build`, `game_length`).
 */
function serializeGameForProfile(g) {
  if (!g) return g;
  const opp = g.opponent || {};
  return {
    ...g,
    id: g.gameId || null,
    date: g.date instanceof Date ? g.date.toISOString() : g.date,
    map: g.map || "",
    result: g.result || "",
    opponent: opp.displayName || "",
    opp_race: opp.race || "",
    opp_strategy: opp.strategy || null,
    my_build: g.myBuild || "",
    my_race: g.myRace || "",
    game_length: g.durationSec || 0,
    macro_score: typeof g.macroScore === "number" ? g.macroScore : null,
  };
}

/**
 * Restrict a games array to those whose `date` falls inside the
 * inclusive [since, until] range. Either bound can be omitted. Games
 * with an unparseable date are kept (matches the rest of the pipeline,
 * which tolerates legacy rows without timestamps).
 *
 * @param {Array<object>} games
 * @param {Date|undefined} since
 * @param {Date|undefined} until
 */
function filterGamesByDate(games, since, until) {
  if (!since && !until) return games;
  const sinceMs =
    since instanceof Date && !Number.isNaN(since.getTime())
      ? since.getTime()
      : null;
  const untilMs =
    until instanceof Date && !Number.isNaN(until.getTime())
      ? until.getTime()
      : null;
  if (sinceMs === null && untilMs === null) return games;
  return games.filter((g) => {
    if (!g || !g.date) return true;
    const t = new Date(g.date).getTime();
    if (Number.isNaN(t)) return true;
    if (sinceMs !== null && t < sinceMs) return false;
    if (untilMs !== null && t > untilMs) return false;
    return true;
  });
}

/**
 * Aggregate W/L by map and by opponent strategy from the games array.
 *
 * @param {Array<object>} games
 */
function aggregateByMapAndStrategy(games) {
  /** @type {Record<string, {wins: number, losses: number}>} */
  const byMap = {};
  /** @type {Record<string, {wins: number, losses: number}>} */
  const byStrategy = {};
  for (const g of games) {
    const isWin = g.result === "Victory";
    const isLoss = g.result === "Defeat";
    const mapName = g.map || "";
    if (mapName) {
      if (!byMap[mapName]) byMap[mapName] = { wins: 0, losses: 0 };
      if (isWin) byMap[mapName].wins += 1;
      if (isLoss) byMap[mapName].losses += 1;
    }
    const strat = g.opp_strategy;
    if (strat) {
      if (!byStrategy[strat]) byStrategy[strat] = { wins: 0, losses: 0 };
      if (isWin) byStrategy[strat].wins += 1;
      if (isLoss) byStrategy[strat].losses += 1;
    }
  }
  return { byMap, byStrategy };
}

/**
 * Compute totals — prefer aggregated game W/L, fall back to the
 * opponent doc's stored counters when no individual games are
 * present (e.g. during partial imports).
 */
function computeTotals(games, doc) {
  let wins = 0;
  let losses = 0;
  for (const g of games) {
    if (g.result === "Victory") wins += 1;
    else if (g.result === "Defeat") losses += 1;
  }
  if (wins === 0 && losses === 0 && doc) {
    wins = doc.wins || 0;
    losses = doc.losses || 0;
  }
  const total = wins + losses;
  return {
    wins,
    losses,
    total,
    winRate: total > 0 ? wins / total : 0,
  };
}

/**
 * Run the DNA helpers against the games array. Pulled out of `get()`
 * to keep the method short.
 *
 * @param {Array<object>} games
 */
function computeDnaFields(games) {
  const myRace = Dna.resolveMyRace(games);
  const oppRaceModal = Dna.resolveModalOppRace(games);
  const medianTimings = Dna.computeMatchupAwareMedianTimings(games, myRace);
  const medianTimingsOrder = Object.keys(medianTimings);
  const matchupLabel = TimingCatalog.matchupLabel(myRace, oppRaceModal);

  /** @type {Record<string, number>} */
  const matchupCounts = {};
  if (myRace) {
    for (const g of games) {
      const r = Dna.gameOppRace(g);
      if (!r) continue;
      const ml = TimingCatalog.matchupLabel(myRace, r);
      if (!ml) continue;
      matchupCounts[ml] = (matchupCounts[ml] || 0) + 1;
    }
  }
  /** @type {Record<string, {timings: object, order: string[]}>} */
  const matchupTimings = {};
  if (myRace) {
    for (const ml of Object.keys(matchupCounts)) {
      const opp = ml.slice(-1);
      const t = Dna.computeMedianTimingsForMatchup(games, myRace, opp);
      matchupTimings[ml] = { timings: t, order: Object.keys(t) };
    }
  }
  const aggregates = aggregateByMapAndStrategy(games);
  const topStrategies = Dna.topStrategiesFromBy(aggregates.byStrategy, 5);
  const predictedStrategies = Dna.recencyWeightedStrategies(games);
  const last5Games = games.slice(0, 5);
  return {
    myRace,
    oppRaceModal,
    medianTimings,
    medianTimingsOrder,
    matchupLabel,
    matchupCounts,
    matchupTimings,
    topStrategies,
    predictedStrategies,
    last5Games,
  };
}

/**
 * Compatibility projection of `medianTimings` for the simpler shape
 * `{ key, median, count }` consumed by the existing
 * `OpponentDnaTimingsDrilldown`. The legacy-shaped payload still ships
 * under `medianTimingsLegacy` / `matchupTimingsLegacy` for the new
 * `MedianTimingsGrid`.
 */
function projectMedianTimings(legacy) {
  /** @type {Record<string, {key: string, median: number|null, count: number}>} */
  const out = {};
  for (const k of Object.keys(legacy || {})) {
    const v = legacy[k] || {};
    out[k] = {
      key: k,
      median: typeof v.medianSeconds === "number" ? v.medianSeconds : null,
      count: v.sampleCount || 0,
    };
  }
  return out;
}

/**
 * Distinct toon handles observed in this opponent's merged games
 * set. Includes the profile doc's own ``toonHandle`` even when zero
 * games are present so the SPA never shows a blank chip on a
 * brand-new opponent. Returns ``[]`` (never ``null``) for a single-
 * toon profile so the UI can branch on ``> 1``.
 *
 * @param {Array<{opponent?: {toonHandle?: string, pulseId?: string}}>} rawGames
 * @param {{toonHandle?: string, pulseId?: string}} doc
 * @returns {string[]}
 */
function collectMergedToonHandles(rawGames, doc) {
  const seen = new Set();
  const ordered = [];
  /** @param {string|undefined} v */
  const consider = (v) => {
    if (typeof v !== "string") return;
    const t = v.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    ordered.push(t);
  };
  // Profile doc first so the "primary" toon stays at the head of
  // the list when the SPA renders the disclosure tooltip.
  if (doc) {
    consider(doc.toonHandle);
    consider(doc.pulseId);
  }
  for (const g of rawGames) {
    if (!g || !g.opponent) continue;
    consider(g.opponent.toonHandle);
    consider(g.opponent.pulseId);
  }
  return ordered;
}

function projectMatchupTimings(legacy) {
  /** @type {Record<string, Record<string, {key: string, median: number|null, count: number}>>} */
  const out = {};
  for (const ml of Object.keys(legacy || {})) {
    out[ml] = projectMedianTimings(legacy[ml] && legacy[ml].timings);
  }
  return out;
}

module.exports = { OpponentsService };
