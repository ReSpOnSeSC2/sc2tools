"use strict";

const { ObjectId } = require("mongodb");
const { LIMITS, COLLECTIONS } = require("../config/constants");
const { hmac } = require("../util/hash");
const { expectedVersion } = require("../db/schemaVersioning");
const { gamesMatchStage } = require("../util/parseQuery");
const { opponentGamesFilter } = require("../util/opponentIdentity");
const { regionFromToonHandle } = require("../util/regionFromToonHandle");
const { canonicalRaceLetter } = require("./oppMmrStamp");
const TimingCatalog = require("./timingCatalog");
const Dna = require("./dnaTimings");
const { computeCompositions } = require("./buildCompositions");
const { computeTransitions } = require("./buildTransitions");
const { computePerGameScouting } = require("./scouting/perGameScouting");

// SC2Pulse MMR refetch window. recordGame / refreshMetadata skip the
// network call entirely when we resolved this opponent's MMR within
// the window — the cap exists so a bulk re-upload of 200 replays
// doesn't trigger 200 sequential SC2Pulse hits per distinct opponent.
// Override per-deployment via env (seconds).
const MMR_PULSE_FRESH_MS = (() => {
  const env = Number(process.env.SC2TOOLS_OPP_MMR_FRESH_SEC);
  if (Number.isFinite(env) && env > 0) return env * 1000;
  return 60 * 60 * 1000;
})();

// Inverse of regionFromToonHandle. Used by the region filter so old
// opponents rows (created before ``region`` was a stored field) still
// match via their toonHandle prefix.
/** @type {Record<string, string>} */
const REGION_TO_HANDLE_PREFIX = { NA: "1", EU: "2", KR: "3", CN: "5", SEA: "6" };

/**
 * @param {string[]} labels
 * @returns {string[]}
 */
function regionLabelsToHandlePrefixes(labels) {
  /** @type {string[]} */
  const out = [];
  for (const l of labels) {
    const code = REGION_TO_HANDLE_PREFIX[l];
    if (code) out.push(code);
  }
  return out;
}

const OPPONENTS_VERSION = expectedVersion(COLLECTIONS.OPPONENTS);

// Profile views load at most this many games (most recent first). An
// opponent faced thousands of times would otherwise pull their entire
// shared history — plus a detail blob per game — into memory per view.
const OPPONENT_PROFILE_MAX_GAMES = 1000;

const PROFILE_GAME_PROJECTION = {
  _id: 0,
  gameId: 1,
  date: 1,
  result: 1,
  map: 1,
  myRace: 1,
  myLadderRace: 1,
  myBuild: 1,
  durationSec: 1,
  macroScore: 1,
  // Internal raw-replay marker. The serializer exposes only availability
  // and size, never its checksum or storage metadata.
  replayFile: 1,
  top3Leaks: 1,
  apm: 1,
  spq: 1,
  // Canonical game-kind fields used by the analyzer's default
  // ladder-1v1 scope. isLadderMap remains projected only for response
  // compatibility; filtering deliberately trusts isLadderGame.
  isLadderGame: 1,
  isLadderMap: 1,
  playerCount: 1,
  matchFormat: 1,
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
  //
  // macroBreakdown projected for legacy (pre-v0.4.3) docs that still
  // carry it inline — the phase classifier in computeCompositions /
  // computeTransitions reads it to compute the trajectory + Sankey on
  // the profile. Post-cutover docs return ``undefined`` for this
  // field and the gameDetails hydration block below fills it from
  // the detail store. Stripped from the response by
  // ``serializeGameForProfile`` so the heavy blob never reaches the
  // client.
  macroBreakdown: 1,
  opponent: 1,
};

// Metadata-only projection for the independently paginated All replays table.
// It intentionally excludes every detail-store field (build logs, macro
// breakdown, timelines, spatial data): expanding a row already fetches that
// one game's detail through the existing per-game endpoint.
const PROFILE_GAME_ROW_PROJECTION = {
  _id: 1,
  gameId: 1,
  date: 1,
  result: 1,
  map: 1,
  myRace: 1,
  myBuild: 1,
  myMmr: 1,
  durationSec: 1,
  macroScore: 1,
  replayFile: 1,
  "opponent.displayName": 1,
  "opponent.race": 1,
  "opponent.strategy": 1,
  "opponent.mmr": 1,
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
   * @param {{
   *   gameDetails?: import('./gameDetails').GameDetailsService,
   *   logger?: any,
   *   pulseResolver?: any,
   *   pulseMmr?: any,
   *   pulseDirectory?: import('./pulseDirectory').PulseDirectoryService | null,
   *   pulseLinks?: import('./pulseCharacterLinks').PulseCharacterLinkService | null,
   * }} [opts]
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
    // Optional SC2Pulse MMR client (the same one GamesService and the
    // session widget already share). When supplied, recordGame /
    // refreshMetadata attempt one rate-limited fetch per ingest to
    // populate ``mmr`` and ``region`` on the opponents row. Stable
    // region metadata may also be copied to a game; current Pulse MMR
    // reaches game rows only through the bounded forward-enrichment
    // job. Best-effort: a Pulse failure leaves the prior opponent-row
    // value untouched and the next encounter retries.
    this.pulseMmr = opts.pulseMmr || null;
    // Global, cross-user SC2Pulse cache. When supplied, opponent MMR /
    // per-race breakdowns pulled by ANY user are served from the
    // shared ``pulse_accounts`` collection before we spend an SC2Pulse
    // round-trip — so the first user to encounter an opponent does the
    // heavy lifting and every later user gets a fully-filled profile
    // instantly. Optional: unit tests that don't exercise sharing pass
    // null and the live-fetch path is unchanged.
    this.pulseDirectory = opts.pulseDirectory || null;
    // SC2Pulse character → account/pro linkage cache
    // (services/pulseCharacterLinks.js). When supplied, ``get`` with
    // ``mergeLinked: true`` folds every opponent row SC2Pulse links to
    // the same player into ONE profile — merged games, totals, and
    // timelines as if all their names were one account. Optional:
    // without it merged profiles silently degrade to single-identity.
    this.pulseLinks = opts.pulseLinks || null;
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
    // Region filter rides the unfiltered fast-path because it doesn't
    // invalidate the cumulative counters the way a date / matchup
    // window does. Two-tier match (stored ``region`` first, toonHandle
    // prefix for rows that haven't been re-ingested since ``region``
    // became a stored field) so old data doesn't fall off the list
    // immediately.
    if (Array.isArray(filters.regions) && filters.regions.length > 0) {
      const prefixes = regionLabelsToHandlePrefixes(filters.regions);
      if (prefixes.length > 0) {
        filter.$or = [
          { region: { $in: filters.regions } },
          {
            region: { $in: [null, ""] },
            toonHandle: { $regex: `^(${prefixes.join("|")})-` },
          },
          {
            region: { $exists: false },
            toonHandle: { $regex: `^(${prefixes.join("|")})-` },
          },
        ];
      }
    }
    /** @type {Array<any>} */
    const items = await this.db.opponents
      .find(filter, { projection: { _id: 0 } })
      .sort({ lastSeen: -1 })
      .limit(limit + 1)
      .toArray();
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    // Capture ``nextBefore`` BEFORE the read-time overlays run.
    // ``_overlayLatestSeenFromGames`` may add a ``lastPlayed`` field
    // surfaced to the frontend, but the cursor still uses the stored
    // ``lastSeen`` so pagination is consistent with the
    // ``{ lastSeen: -1 }`` sort above.
    const nextBefore = hasMore ? page[page.length - 1].lastSeen : null;
    for (const row of page) delete row._resumeReplayCounterRepairIds;
    // Self-heal ``displayNameSample`` and ``lastSeen`` from the games
    // collection. The row's stored values are whatever the most recent
    // ingest wrote — which the May-2026 write guard now keeps in sync,
    // but rows that pre-date the guard are still stale until the
    // backfill migration runs. Recomputing from games at read time
    // means the list shows the right values regardless of migration
    // state. Two batched aggregations per page (each uses the
    // ``{opponent.pulseId, userId, date}`` index).
    await Promise.all([
      this._overlayLatestNameFromGames(userId, page),
      this._overlayLatestSeenFromGames(userId, page),
      this._overlayLatestMmrFromGames(userId, page),
    ]);
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

    /** @type {any[]} */
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

    /** @type {Array<any>} */
    const items = await this.db.games.aggregate(pipeline).toArray();
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextBefore = hasMore ? page[page.length - 1].lastPlayed : null;
    // Two overlays:
    //
    // (1) Identity fields (``pulseCharacterId`` / ``toonHandle``) —
    //     fill-if-missing from the opponents row. The aggregation
    //     pulls these off the embedded opponent sub-doc on the most
    //     recent game (``$last``), but those fields are only stamped
    //     onto a games row at the moment of upload. The May-2026
    //     backfill cron heals the opponents COLLECTION row for
    //     stuck-on-TOON opponents by writing the canonical
    //     pulseCharacterId there directly; it does NOT rewrite
    //     historical games rows (we keep games immutable). For an
    //     opponent whose games all pre-date the heal, ``$last``
    //     returns null even though the opponents row holds the
    //     canonical id — splice the row's value in when the
    //     aggregation produced null.
    //
    // (2) ``displayNameSample`` — recompute from games. The
    //     aggregation's ``$last`` is unsorted (non-deterministic) and
    //     scoped to the FILTER WINDOW; trusting the opponents row
    //     would work post-migration but is stale for rows that
    //     pre-date the write guard. Computing the global-latest name
    //     from games at read time is self-healing and applies rule
    //     (i): the displayed name is an identity label, not a
    //     windowed stat — always the player's most-recent name
    //     across all history.
    await this._overlayFromOpponents(userId, page);
    await this._overlayRevealedNamesFromOpponents(userId, page);
    await this._overlayLatestNameFromGames(userId, page);
    // (3) ``mmr`` / ``region`` — safety net for rows whose ``$last``
    //     accumulator landed on a game without ``opponent.mmr`` (the
    //     accumulator is non-deterministic without a prior $sort, so
    //     a mmr-less game can win the "last" slot even when a sibling
    //     game in the same group carries the field). Same overlay
    //     used by the unfiltered path: zero outbound Pulse traffic.
    await this._overlayLatestMmrFromGames(userId, page);
    return { items: page, nextBefore };
  }

  /**
   * In-place fill of missing identity fields from the opponents
   * collection onto an aggregation result page. One ``find``
   * round-trip regardless of page size (uses the existing
   * ``{ userId, pulseId }`` unique index for an index scan).
   *
   * ``pulseCharacterId`` / ``toonHandle`` are fill-if-missing. We
   * trust the games-rows when they carry the value, and only splice
   * from the opponents row when the games aggregation produced
   * null. Never overwrites a non-null aggregation value — games rows
   * remain the authority on the most-recent observed identity.
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
  async _overlayFromOpponents(userId, rows) {
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
   * In-place splice of each opponent's SC2Pulse "revealed" name
   * (``revealedName``) from the opponents collection onto an
   * aggregation result page.
   *
   * Unlike ``pulseCharacterId`` / ``toonHandle``, ``revealedName`` is
   * NEVER stamped onto games rows — it lives only on the opponents
   * collection row (populated by the MMR fetch / reveal re-check
   * passes). So the list aggregation (which reads off the embedded
   * ``opponent`` sub-doc) can't surface it; we read it directly here.
   * One indexed ``find`` round-trip regardless of page size. No-op on
   * an empty page or when no row carries a reveal.
   *
   * @private
   * @param {string} userId
   * @param {Array<{ pulseId: string, revealedName?: string|null }>} rows
   */
  async _overlayRevealedNamesFromOpponents(userId, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const ids = rows
      .map((r) => (r && typeof r.pulseId === "string" ? r.pulseId : null))
      .filter((id) => id);
    if (ids.length === 0) return;
    const cursor = this.db.opponents.find(
      { userId, pulseId: { $in: ids }, revealedName: { $type: "string", $ne: "" } },
      { projection: { _id: 0, pulseId: 1, revealedName: 1 } },
    );
    /** @type {Map<string, string>} */
    const byPulseId = new Map();
    for await (const doc of cursor) {
      if (typeof doc.pulseId === "string" && typeof doc.revealedName === "string") {
        byPulseId.set(doc.pulseId, doc.revealedName);
      }
    }
    if (byPulseId.size === 0) return;
    for (const r of rows) {
      if (!r || typeof r.pulseId !== "string") continue;
      const name = byPulseId.get(r.pulseId);
      if (name) r.revealedName = name;
    }
  }

  /**
   * In-place overlay of ``displayNameSample`` with the displayName
   * of each opponent's globally-most-recent game by date. Source of
   * truth: the games collection (immutable, dated, definitive).
   *
   * Why "from games" instead of "from the opponents row":
   *   * The row's ``displayNameSample`` is maintained by
   *     ``recordGame`` / ``refreshMetadata``, but rows that pre-date
   *     the May-2026 write guard hold stale values until the
   *     ``2026-05-12-heal-opponent-current-name`` migration runs.
   *     Computing from games at read time is self-healing and
   *     makes the migration purely an optimization.
   *   * Rule (i): the displayed name is an identity label, not a
   *     windowed stat. Always the player's MOST-RECENT name across
   *     all history, regardless of any active date filter.
   *
   * One aggregation per page. Uses the
   * ``{opponent.pulseId, userId, date}`` index for the sort. Games
   * with empty/null ``opponent.displayName`` are excluded so a
   * stray bad row doesn't blank the latest valid name.
   *
   * Safe on an empty page.
   *
   * @private
   * @param {string} userId
   * @param {Array<{pulseId: string, displayNameSample?: string}>} rows
   */
  async _overlayLatestNameFromGames(userId, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const pulseIds = [];
    for (const r of rows) {
      if (r && typeof r.pulseId === "string" && r.pulseId.length > 0) {
        pulseIds.push(r.pulseId);
      }
    }
    if (pulseIds.length === 0) return;
    const cursor = this.db.games.aggregate([
      {
        $match: {
          userId,
          isResumedFromReplay: { $ne: true },
          "opponent.pulseId": { $in: pulseIds },
          "opponent.displayName": { $type: "string", $ne: "" },
        },
      },
      { $sort: { date: -1 } },
      {
        $group: {
          _id: "$opponent.pulseId",
          latestName: { $first: "$opponent.displayName" },
        },
      },
    ]);
    /** @type {Map<string, string>} */
    const byPulseId = new Map();
    for await (const doc of cursor) {
      if (typeof doc._id === "string" && typeof doc.latestName === "string") {
        byPulseId.set(doc._id, doc.latestName);
      }
    }
    for (const r of rows) {
      if (!r || typeof r.pulseId !== "string") continue;
      const latest = byPulseId.get(r.pulseId);
      if (typeof latest === "string" && latest.length > 0) {
        r.displayNameSample = latest;
      }
    }
  }

  /**
   * In-place overlay of the "Last MMR" column: the opponent's MMR in
   * the race they played in your MOST RECENT game against them.
   *
   * Two-step, race-aware selection (this is the fix for the "shows the
   * opponent's highest-race MMR, not the race I actually played" bug —
   * e.g. a row whose last game was the opponent's Terran (5400) was
   * showing their Protoss (6360) because that's the race they ladder
   * most):
   *   1. RECOGNISE the race — find the opponent's race in the most
   *      recent game you have on record against them.
   *   2. PICK the MMR for THAT race — the most recent game of that race
   *      that carries an ``opponent.mmr`` (from replay data or the
   *      race-correct forward enrichment job). A Protoss game's rating
   *      is therefore never lent to a row whose last game was Terran.
   *
   * This is preferred over the opponents-row stored ``mmr``, which is
   * SC2Pulse's *current* rating collapsed across races —
   * ``_fetchTeams`` picks the team played most-recently-on-ladder
   * (tie-break highest rating), i.e. race-AGNOSTIC. For a multi-race
   * opponent that's the wrong number.
   *
   * Fallback to the opponents-row stored ``mmr`` only when no game of
   * the latest race carries one (the replay omitted it and recent
   * enrichment had no matching Pulse team). That's the AngryBird case:
   * ranked-1v1 replays are mmr-less, so the row holds the only number we
   * have. The unfiltered
   * path already carries the stored mmr on the row; the filtered path
   * looks it up (its aggregation rows don't carry it).
   *
   * PURE-DATABASE overlay: zero outbound SC2Pulse traffic. Two games
   * aggregations per page (latest race, then most-recent mmr per race —
   * both ride the ``{opponent.pulseId, userId, date}`` index) plus at
   * most one opponents ``find`` for the fallback tier. Safe on an empty
   * page.
   *
   * @private
   * @param {string} userId
   * @param {Array<{
   *   pulseId: string,
   *   mmr?: number|null,
   *   region?: string|null,
   * }>} rows
   */
  async _overlayLatestMmrFromGames(userId, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const pulseIds = [];
    for (const r of rows) {
      if (!r || typeof r.pulseId !== "string" || r.pulseId.length === 0) {
        continue;
      }
      pulseIds.push(r.pulseId);
    }
    if (pulseIds.length === 0) return;
    // Step 1 — RECOGNISE the race: the opponent's race in the most
    // recent game on record for each opponent. This is the race whose
    // MMR the "Last MMR" column must show.
    /** @type {Map<string, string>} */
    const latestRaceByPulse = new Map();
    const raceCursor = this.db.games.aggregate([
      {
        $match: {
          userId,
          isResumedFromReplay: { $ne: true },
          "opponent.pulseId": { $in: pulseIds },
        },
      },
      { $sort: { date: -1 } },
      {
        $group: {
          _id: "$opponent.pulseId",
          latestRace: { $first: "$opponent.race" },
        },
      },
    ]);
    for await (const doc of raceCursor) {
      if (typeof doc._id !== "string") continue;
      if (typeof doc.latestRace === "string") {
        latestRaceByPulse.set(doc._id, doc.latestRace);
      }
    }
    // Step 2 — PICK the MMR for that race: the most recent game-with-mmr
    // per (opponent, race). Keyed by the canonical race LETTER so the
    // "Terran"/"T" spellings collapse together. Grouping by race here is
    // what stops a Protoss game from lending its rating to a row whose
    // last game was Terran.
    /** @type {Map<string, {mmr: number, region?: string|null}>} */
    const byPulseRace = new Map();
    const mmrCursor = this.db.games.aggregate([
      {
        $match: {
          userId,
          isResumedFromReplay: { $ne: true },
          "opponent.pulseId": { $in: pulseIds },
          "opponent.mmr": { $type: "number" },
        },
      },
      { $sort: { date: -1 } },
      {
        $group: {
          _id: {
            pulseId: "$opponent.pulseId",
            letter: {
              $toUpper: {
                $substrCP: [{ $ifNull: ["$opponent.race", ""] }, 0, 1],
              },
            },
          },
          mmr: { $first: "$opponent.mmr" },
          region: { $first: "$opponent.region" },
        },
      },
    ]);
    for await (const doc of mmrCursor) {
      const id = doc && doc._id;
      if (!id || typeof id.pulseId !== "string" || typeof id.letter !== "string") {
        continue;
      }
      const mmr = Number(doc.mmr);
      if (!Number.isFinite(mmr) || mmr <= 0) continue;
      byPulseRace.set(`${id.pulseId}|${id.letter}`, {
        mmr: Math.round(mmr),
        region: typeof doc.region === "string" ? doc.region : null,
      });
    }
    // Resolve the race-correct mmr for each row.
    /** @type {Map<string, {mmr: number, region?: string|null}>} */
    const matched = new Map();
    for (const r of rows) {
      if (!r || typeof r.pulseId !== "string") continue;
      const letter = canonicalRaceLetter(latestRaceByPulse.get(r.pulseId));
      if (!letter) continue;
      const hit = byPulseRace.get(`${r.pulseId}|${letter}`);
      if (hit) matched.set(r.pulseId, hit);
    }
    // Fallback tier: for any row with NO race-matched game mmr AND no
    // stored mmr already on it, fall back to the opponents-collection
    // row's stored ``mmr`` / ``region``. That's where the SC2Pulse
    // current-MMR fetch in ``recordGame`` lands — sc2reader almost never
    // carries opponent.mmr for ranked 1v1 replays, so for high-ladder
    // opponents the opponents-row value is the ONLY place we have the
    // number. Without this fallback the filtered Opponents tab silently
    // blanks the MMR column for anyone whose every game in the filter
    // window was missing opponent.mmr (the bug surfaced as "the mmr
    // disappeared for AngryBird"). The unfiltered path already carries
    // the stored mmr on the row, so it never reaches this lookup.
    /** @type {string[]} */
    const stillMissing = [];
    for (const r of rows) {
      if (!r || typeof r.pulseId !== "string") continue;
      if (matched.has(r.pulseId)) continue;
      if (typeof r.mmr === "number") continue;
      stillMissing.push(r.pulseId);
    }
    /** @type {Map<string, {mmr: number, region?: string|null}>} */
    const opponentsFallback = new Map();
    if (stillMissing.length > 0) {
      const oppCursor = this.db.opponents.find(
        { userId, pulseId: { $in: stillMissing }, mmr: { $type: "number" } },
        { projection: { _id: 0, pulseId: 1, mmr: 1, region: 1 } },
      );
      for await (const doc of oppCursor) {
        if (typeof doc.pulseId !== "string") continue;
        const mmr = Number(doc.mmr);
        if (!Number.isFinite(mmr) || mmr <= 0) continue;
        opponentsFallback.set(doc.pulseId, {
          mmr: Math.round(mmr),
          region: typeof doc.region === "string" ? doc.region : null,
        });
      }
    }
    for (const r of rows) {
      if (!r || typeof r.pulseId !== "string") continue;
      // Race-correct most-recent-game mmr WINS over the row's stored
      // (race-agnostic) value.
      const found = matched.get(r.pulseId);
      if (found) {
        r.mmr = found.mmr;
        if (
          (r.region == null || r.region === "")
          && typeof found.region === "string"
        ) {
          r.region = found.region;
        }
        continue;
      }
      // No same-race game carries an mmr — keep the stored value if the
      // row already has one, else use the opponents-collection fallback.
      if (typeof r.mmr === "number") continue;
      const fb = opponentsFallback.get(r.pulseId);
      if (!fb) continue;
      r.mmr = fb.mmr;
      if (
        (r.region == null || r.region === "")
        && typeof fb.region === "string"
      ) {
        r.region = fb.region;
      }
    }
  }

  /**
   * In-place overlay of ``lastPlayed`` with each opponent's
   * globally-most-recent game date. Source of truth: the games
   * collection (immutable, dated, definitive).
   *
   * Why "from games" instead of the opponents row's ``lastSeen``:
   *   * The row's ``lastSeen`` is maintained by ``recordGame`` /
   *     ``refreshMetadata``, but rows that pre-date the May-2026
   *     write guard hold stale values until the
   *     ``2026-05-12-heal-opponent-current-name`` migration runs.
   *     Until then, the Opponents tab would show a "Last" column
   *     full of 2018-era dates for opponents the user actually
   *     played this season.
   *   * Computing from games at read time is self-healing and makes
   *     the migration purely a sort-order optimization.
   *
   * Only the UNFILTERED list path calls this overlay. ``_listFiltered``
   * already computes ``lastPlayed = $max("$date")`` WITHIN the active
   * filter window, which is the correct windowed value — overwriting
   * it with the global-latest date would defeat the date filter.
   *
   * Surfaces the date as ``lastPlayed`` (new field) rather than
   * mutating the stored ``lastSeen`` on the row, so the
   * ``page[len-1].lastSeen`` cursor captured above stays aligned with
   * the ``{ lastSeen: -1 }`` index sort. The SPA's row normaliser
   * (``OpponentsTab.tsx``) already prefers ``lastPlayed`` over
   * ``lastSeen``, matching the filtered path's output shape.
   *
   * Opportunistic write-back: when stored ``lastSeen`` is older than
   * the games-derived latest, we queue a bulk update to heal the row
   * in place. Failures are non-fatal — the next read will retry.
   * This means a stale-row user gets corrected sort order on their
   * next list call, without waiting for the one-shot migration.
   *
   * One aggregation per page. Uses the
   * ``{opponent.pulseId, userId, date}`` index. Safe on an empty page.
   *
   * @private
   * @param {string} userId
   * @param {Array<{pulseId: string, lastSeen?: Date|null, lastPlayed?: Date|null}>} rows
   */
  async _overlayLatestSeenFromGames(userId, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const pulseIds = [];
    for (const r of rows) {
      if (r && typeof r.pulseId === "string" && r.pulseId.length > 0) {
        pulseIds.push(r.pulseId);
      }
    }
    if (pulseIds.length === 0) return;
    const cursor = this.db.games.aggregate([
      {
        $match: {
          userId,
          isResumedFromReplay: { $ne: true },
          "opponent.pulseId": { $in: pulseIds },
        },
      },
      {
        $group: {
          _id: "$opponent.pulseId",
          latestDate: { $max: "$date" },
        },
      },
    ]);
    /** @type {Map<string, Date>} */
    const byPulseId = new Map();
    for await (const doc of cursor) {
      if (typeof doc._id === "string" && doc.latestDate instanceof Date) {
        byPulseId.set(doc._id, doc.latestDate);
      }
    }
    /** @type {Array<{updateOne: {filter: object, update: object}}>} */
    const heals = [];
    for (const r of rows) {
      if (!r || typeof r.pulseId !== "string") continue;
      const latest = byPulseId.get(r.pulseId);
      if (!(latest instanceof Date)) continue;
      const stored = r.lastSeen instanceof Date ? r.lastSeen : null;
      const storedMs = stored ? stored.getTime() : 0;
      const latestMs = latest.getTime();
      if (latestMs > storedMs) {
        // Surface to the frontend immediately.
        r.lastPlayed = latest;
        // Heal the stored row so the next list call's
        // ``{ lastSeen: -1 }`` sort places this opponent correctly.
        heals.push({
          updateOne: {
            filter: { userId, pulseId: r.pulseId },
            update: { $set: { lastSeen: latest } },
          },
        });
      }
    }
    if (heals.length === 0) return;
    try {
      await this.db.opponents.bulkWrite(heals, { ordered: false });
    } catch (err) {
      this.logger.warn(
        { err, userId, count: heals.length },
        "opponents_lastseen_heal_failed",
      );
    }
  }

  /**
   * Resolve the SC2Pulse-linked identity group the given opponent row
   * belongs to, scoped to THIS user's opponents. Two rows are the same
   * player when SC2Pulse maps their character ids to the same
   * community-verified player (``proId``, which spans accounts) or,
   * failing that, the same Battle.net account (``accountId``).
   *
   * Returns ``null`` — meaning "profile stays single-identity" — when
   * the links service isn't wired, this row has no resolved character
   * id, the id has no known linkage, only one of the user's rows is in
   * the group, or anything at all fails. A merged profile is an
   * enhancement, never a availability risk.
   *
   * @private
   * @param {string} userId
   * @param {Record<string, any>} doc opponents-collection row being opened
   * @returns {Promise<{
   *   identities: Array<ReturnType<typeof serializeLinkedIdentity>>,
   *   pulseIds: string[],
   *   characterIds: string[],
   *   revealedName: string|null,
   *   mainName: string|null,
   * } | null>}
   */
  async _resolveLinkedIdentities(userId, doc) {
    if (!this.pulseLinks) return null;
    const selfCid =
      typeof doc.pulseCharacterId === "string" && doc.pulseCharacterId
        ? doc.pulseCharacterId
        : null;
    if (!selfCid) return null;
    try {
      /** @type {Array<any>} */
      const rows = await this.db.opponents
        .find(
          { userId, pulseCharacterId: { $type: "string", $ne: "" } },
          {
            projection: {
              _id: 0,
              pulseId: 1, pulseCharacterId: 1, toonHandle: 1,
              displayNameSample: 1, revealedName: 1,
              wins: 1, losses: 1, gameCount: 1, lastSeen: 1,
            },
          },
        )
        .toArray();
      const { links } = await this.pulseLinks.getLinks(
        rows.map((r) => r.pulseCharacterId),
      );
      const selfLink = links.get(selfCid) || null;
      const selfKey = linkGroupKey(selfLink);
      if (!selfKey) return null;
      const identities = rows.filter(
        (r) => linkGroupKey(links.get(r.pulseCharacterId)) === selfKey,
      );
      if (identities.length <= 1) return null;
      identities.sort((a, b) => lastSeenMs(b) - lastSeenMs(a));
      // Same self-healing latest-name overlay the list uses, so each
      // identity is labeled with the name it most recently played
      // under rather than a stale stored sample.
      await this._overlayLatestNameFromGames(userId, identities);
      const revealedName =
        identities
          .map((r) =>
            typeof r.revealedName === "string" ? r.revealedName.trim() : "",
          )
          .find((n) => n.length > 0)
        || (selfLink ? selfLink.proNickname : null)
        || null;
      return {
        identities: identities.map(serializeLinkedIdentity),
        pulseIds: identities.map((r) => r.pulseId),
        characterIds: [...new Set(identities.map((r) => r.pulseCharacterId))],
        revealedName,
        mainName: pickMergedMainName(identities, revealedName),
      };
    } catch (err) {
      this.logger.warn(
        { err, userId, pulseId: doc.pulseId },
        "opponent_linked_merge_failed",
      );
      return null;
    }
  }

  /**
   * Cursor-page the complete replay history for one opponent without loading
   * any game-detail blobs. This is the data source for the dossier's All
   * replays table; the heavier `get` method remains capped for analytics.
   *
   * The cursor is an opaque `{date, _id}` tuple. `_id` is the deterministic
   * tie-breaker for replays with identical timestamps, so paging cannot skip
   * or duplicate rows uploaded in the same agent batch.
   *
   * @param {string} userId
   * @param {string} pulseId
   * @param {{
   *   filters?: import('../util/parseQuery').GlobalFilters,
   *   mergeLinked?: boolean,
   *   limit?: number,
   *   cursor?: string,
   * }} [opts]
   * @returns {Promise<{items: object[], nextCursor: string|null}|null>}
   */
  async listGames(userId, pulseId, opts = {}) {
    const doc = await this.db.opponents.findOne(
      { userId, pulseId },
      {
        projection: {
          _id: 0,
          userId: 1,
          pulseId: 1,
          pulseCharacterId: 1,
          toonHandle: 1,
          displayNameSample: 1,
          revealedName: 1,
          wins: 1,
          losses: 1,
          gameCount: 1,
          lastSeen: 1,
        },
      },
    );
    if (!doc) return null;

    const linked = opts.mergeLinked
      ? await this._resolveLinkedIdentities(userId, doc)
      : null;
    const identityFilter = profileGamesIdentityFilter(pulseId, doc, linked);

    const cursor = decodeOpponentGamesCursor(opts.cursor);
    const clauses = [
      gamesMatchStage(userId, opts.filters || {}),
      identityFilter,
    ];
    if (cursor) {
      clauses.push({
        $or: [
          { date: { $lt: cursor.date } },
          { date: cursor.date, _id: { $lt: cursor.id } },
        ],
      });
    }

    const limit = clampOpponentGamesLimit(opts.limit);
    /** @type {Array<any>} */
    const rows = await this.db.games
      .find({ $and: clauses }, { projection: PROFILE_GAME_ROW_PROJECTION })
      .sort({ date: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map(serializeCompactProfileGame),
      nextCursor: hasMore && last
        ? encodeOpponentGamesCursor(last.date, last._id)
        : null,
    };
  }

  /**
   * Build the full opponent profile payload consumed by the SPA's
   * `OpponentProfile` view: totals, byMap, byStrategy, top strategies,
   * recency-weighted predictions, matchup-aware median timings (overall
   * + per matchup), last 5 games, and the full games array (newest
   * first) for the all-games table.
   *
   * Analyzer filtering: totals / byMap / byStrategy / topStrategies /
   * timings / phases / scouting / the all-games table are computed from
   * the shared analyzer scope. `last5Games` and `predictedStrategies`
   * intentionally ignore only the date bounds (they describe recent
   * activity), while still honoring game-kind, race, map, and other
   * cohort filters. This prevents a ladder-1v1 profile from silently
   * re-introducing custom or team replays after drill-in.
   *
   * Linked-player merge: with ``opts.mergeLinked`` set (and the
   * pulseLinks service wired), the profile spans EVERY opponent row
   * SC2Pulse links to the same player — the games arrays, totals,
   * per-map/strategy rollups, phase envelopes, and predictions all
   * read as if the player's names were one account. The payload gains
   * ``mergedIdentities`` (per-name breakdown, newest first) and the
   * heading name prefers the SC2Pulse revealed/pro name.
   *
   * @param {string} userId
   * @param {string} pulseId
   * @param {{
   *   filters?: import('../util/parseQuery').GlobalFilters,
   *   since?: Date,
   *   until?: Date,
   *   mergeLinked?: boolean,
   * }} [opts]
   */
  async get(userId, pulseId, opts = {}) {
    // Keep direct since/until options working for internal callers and
    // older tests while the HTTP route supplies the complete parsed
    // filter object.
    const filters = { ...(opts.filters || {}) };
    if (!filters.since && opts.since) filters.since = opts.since;
    if (!filters.until && opts.until) filters.until = opts.until;
    const doc = await this.db.opponents.findOne(
      { userId, pulseId },
      { projection: { _id: 0 } },
    );
    if (!doc) return null;
    delete doc._resumeReplayCounterRepairIds;
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
    // SC2Pulse-linked merge (see method jsdoc). ``null`` — no links
    // service, unresolved character id, single-identity group, or any
    // failure — falls through to the single-identity filter unchanged.
    const linked = opts.mergeLinked
      ? await this._resolveLinkedIdentities(userId, doc)
      : null;
    /** @type {Record<string, any>} */
    const gamesFilter = linked
      ? {
          userId,
          $or: [
            { "opponent.pulseId": { $in: linked.pulseIds } },
            { "opponent.pulseCharacterId": { $in: linked.characterIds } },
          ],
        }
      : idsFilter
        ? { userId, ...idsFilter }
        : { userId, "opponent.pulseId": pulseId };
    gamesFilter.isResumedFromReplay = { $ne: true };
    /** @type {Array<any>} */
    const fetchedGames = await this.db.games
      .find(gamesFilter, { projection: PROFILE_GAME_PROJECTION })
      .sort({ date: -1 })
      // Hard cap: an opponent faced hundreds/thousands of times would
      // otherwise load every shared game — plus a detail-blob fetch
      // per game below — into memory on every profile view. date:-1
      // keeps the most recent games, which are the ones the profile's
      // tendency stats should weight anyway.
      // Fetch one sentinel row so the response can describe the cap honestly
      // instead of labelling a truncated table "All replays".
      .limit(OPPONENT_PROFILE_MAX_GAMES + 1)
      .toArray();
    const gamesTruncated = fetchedGames.length > OPPONENT_PROFILE_MAX_GAMES;
    const rawGames = fetchedGames.slice(0, OPPONENT_PROFILE_MAX_GAMES);
    // dnaTimings reads ``buildLog`` / ``oppBuildLog`` off each game
    // object to compute first-occurrence-of-token timings, and the
    // phase classifier (powering the trajectory strip + transition
    // Sankey on the profile) reads ``macroBreakdown``. All three
    // fields live on the detail store after the v0.4.3 cutover —
    // bulk-fetch them in one batched query so the per-profile cost
    // is constant regardless of game count.
    if (this.gameDetails && rawGames.length > 0) {
      const needIds = [];
      for (const g of rawGames) {
        const missingLogs =
          !Array.isArray(g.buildLog) || !Array.isArray(g.oppBuildLog);
        const missingMacro = !g.macroBreakdown;
        if (missingLogs || missingMacro) {
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
          if (!g.macroBreakdown && blob.macroBreakdown) {
            g.macroBreakdown = blob.macroBreakdown;
          }
        }
      }
    }
    // Apply every non-date analyzer facet before deriving profile
    // aggregates. Date bounds remain separate so recency-oriented panels
    // can intentionally show the latest games inside the same cohort.
    const scopedRawGames = filterGamesByAnalyzerScope(rawGames, filters);
    const rawFilteredGames = filterGamesByDate(
      scopedRawGames, filters.since, filters.until,
    );
    const allGames = scopedRawGames.map(serializeGameForProfile);
    const filteredGames = rawFilteredGames.map(serializeGameForProfile);
    // Authoritative current name. ``rawGames`` is sorted by date desc
    // and is NOT filtered by ``opts.since`` / ``opts.until`` — so
    // ``[0]`` is the absolute most-recent game we've ingested for
    // this opponent across all history. Its ``opponent.displayName``
    // is therefore the canonical "what is this player currently
    // called". This is rule (i) from the design discussion: the
    // profile heading is an identity label, never a windowed stat —
    // it should read the same regardless of the filter the user has
    // active.
    //
    // Falls back to ``doc.displayNameSample`` when this opponent has
    // no games on record (shouldn't happen in practice — the row
    // exists because games created it — but defensive against the
    // admin "Rebuild opponents" path leaving an empty row mid-cycle).
    // The fallback also makes this read self-healing: even before the
    // backfill migration runs, the profile picks the right name from
    // the games on every load.
    const latestGameName = rawGames.length > 0
      && rawGames[0]
      && rawGames[0].opponent
      && typeof rawGames[0].opponent.displayName === "string"
      && rawGames[0].opponent.displayName.length > 0
      ? rawGames[0].opponent.displayName
      : null;
    // Merged profiles lead with the player's MOST-KNOWN name — the
    // SC2Pulse revealed/pro name when there is one, else the readable
    // name they've played the most games under — so the heading
    // matches what the grouped Opponents list shows. Single-identity
    // profiles keep rule (i): the latest-game name.
    const authoritativeName = linked
      ? linked.mainName || latestGameName || doc.displayNameSample || ""
      : latestGameName || doc.displayNameSample || "";
    // Cross-toon merge surfacing: if the rawGames span multiple toon
    // handles (the Battle.net rebind case), expose the merged set so
    // the SPA can render a "merged across N toons" disclosure chip
    // without needing a second round-trip. Single-toon profiles
    // omit this field entirely so the UI shows nothing extra.
    const mergedToonHandles = collectMergedToonHandles(rawGames, doc);
    const aggregates = aggregateByMapAndStrategy(filteredGames);
    // A real filter that happens to match zero games must return zero;
    // falling back to the opponent row's lifetime counters would make the
    // filter appear broken. Retain that fallback only for an unscoped
    // legacy profile request.
    const totals = computeTotals(
      filteredGames,
      hasProfileFilters(filters) ? null : doc,
    );
    const dna = computeDnaFields(filteredGames);
    // Phase trajectory + transition Sankey for "How games against this
    // opponent play out". Pure compute over the same date-filtered
    // games that drive the by-map / by-strategy / median-timings
    // panels — keeps the section consistent with the rest of the
    // profile when the user narrows the date range. Caller's perspective
    // (myRace + macroBreakdown) drives the classifier; the col-0 node
    // labels the opponent so the Sankey reads
    //   "vs <name> → <race> → <strategy> → <finalPhase>".
    const opponentLabel = authoritativeName
      ? `vs ${authoritativeName}`
      : "vs opponent";
    // Same raw, date-filtered cohort the by-map/by-strategy aggregates
    // use; retaining raw rows here keeps detail-backed phase data intact.
    const phasesCompute = computeCompositions(rawFilteredGames);
    const transitionsCompute = computeTransitions(rawFilteredGames, {
      mode: "opponent",
      label: opponentLabel,
    });
    // Per-strategy phase envelopes power the "Strategies that play out
    // at <phase>" storyline cards under each phase tab. Pure compute:
    // group the same date-filtered games by ``opponent.strategy`` and
    // call ``computeCompositions`` per group. Cap at the top 6 by game
    // count so the payload stays bounded; everything beyond is folded
    // into the aggregate above.
    const byStrategy = computeByStrategyPhases(rawFilteredGames, {
      perspective: "opponent",
      maxStrategies: 6,
    });
    const phases = {
      slug: pulseId,
      name: opponentLabel,
      sampleSize: phasesCompute.sampleSize,
      perPhase: phasesCompute.perPhase,
      finalPhaseDistribution: phasesCompute.finalPhaseDistribution,
      medianCrossings: phasesCompute.medianCrossings,
      durationP95Sec: phasesCompute.durationP95Sec,
      flags: phasesCompute.flags,
      byStrategy,
    };
    const transitions = {
      slug: pulseId,
      name: opponentLabel,
      transitions: transitionsCompute,
    };
    // Predictions and the most-recent-5 list ignore date bounds but
    // remain inside the active analyzer cohort — see method jsdoc.
    const predictedStrategies = Dna.recencyWeightedStrategies(allGames);
    const last5Games = allGames.slice(0, 5);
    // Per-game scouting envelopes for the overlay's scouting widget.
    // Operates on the un-serialized scopedRawGames entries (which still
    // carry ``macroBreakdown`` + ``oppBuildLog``) so the per-game
    // build-order strip + composition snapshots have real source
    // data. ``serializeGameForProfile`` strips the heavy blobs from
    // ``allGames``, hence the raw-side traversal here. The compute
    // itself lives in ``scouting/perGameScouting.js`` to keep this
    // file under the 800-line ceiling.
    const last5GamesScouting = scopedRawGames.slice(0, 5).map((g) => {
      try {
        return computePerGameScouting(g);
      } catch (err) {
        const e = /** @type {{ message?: unknown }} */ (err);
        console.warn(
          "perGameScouting failed for gameId=%s userId=%s: %s",
          g && g.gameId, userId, (e && e.message) || e,
        );
        return null;
      }
    }).filter((envelope) => envelope !== null);
    // Per-game scouting envelopes for EVERY date-filtered game — the
    // opponent profile's "How games against this opponent play out"
    // widget tabs through these to show real build orders, real
    // compositions, real transitions, and real end-of-game phase /
    // reason per replay. Operates on ``rawFilteredGames`` so the set
    // respects the active date range (same filter the by-map /
    // by-strategy panels use). Capped so a profile against an opponent
    // with hundreds of games doesn't blow the response size; the
    // overlay's last-5 surface keeps its dedicated field above.
    const PROFILE_SCOUTING_CAP = 60;
    const gamesScouting = rawFilteredGames
      .slice(0, PROFILE_SCOUTING_CAP)
      .map((g) => {
        try {
          return computePerGameScouting(g);
        } catch (err) {
          const e = /** @type {{ message?: unknown }} */ (err);
          console.warn(
            "perGameScouting failed for gameId=%s userId=%s: %s",
            g && g.gameId, userId, (e && e.message) || e,
          );
          return null;
        }
      })
      .filter((envelope) => envelope !== null);
    const matchupTimingsLegacy = dna.matchupTimings;
    const matchupTimings = projectMatchupTimings(matchupTimingsLegacy);
    // "Last MMR" overlay — same race-aware contract as the list path.
    // The column means "the opponent's rating in the race they played
    // in your most recent game against them". ``rawGames`` is sorted
    // date desc, so rawGames[0] is the most recent game; we take its
    // opponent race, then surface the MMR from the most recent game OF
    // THAT RACE that carries one (from replay data or the race-correct
    // forward enrichment job). It WINS over the opponents-row
    // ``doc.mmr`` — SC2Pulse's race-AGNOSTIC current rating
    // (``_fetchTeams`` collapses all races to the most-recently-played
    // team), which would surface the wrong race for a multi-race
    // opponent (their Protoss 6360 on a row whose last game was Terran
    // 5400). Falls back to ``doc.mmr`` when no same-race game carries
    // one (the replay omitted it and recent enrichment missed). Pure
    // database read — no Pulse traffic.
    /** @type {{mmr: number, region: string|null}|null} */
    let mmrOverlay = null;
    const latestOppRace =
      rawGames.length > 0 && rawGames[0] && rawGames[0].opponent
        ? rawGames[0].opponent.race
        : null;
    const latestOppLetter = canonicalRaceLetter(latestOppRace);
    if (latestOppLetter) {
      for (const g of rawGames) {
        const gLetter = canonicalRaceLetter(
          g && g.opponent && g.opponent.race,
        );
        if (gLetter !== latestOppLetter) continue;
        const m = Number(g && g.opponent && g.opponent.mmr);
        if (!Number.isFinite(m) || m <= 0) continue;
        mmrOverlay = {
          mmr: Math.round(m),
          region: typeof g.opponent.region === "string"
            ? g.opponent.region
            : null,
        };
        break;
      }
    }
    return {
      ...doc,
      // Overlay the row's displayNameSample with the authoritative
      // latest-game name so downstream consumers that read either
      // field see the same value.
      displayNameSample: authoritativeName || doc.displayNameSample || "",
      name: authoritativeName,
      // Merged extras: the per-name breakdown (newest first) and the
      // group's revealed name — any identity's reveal (or the pro
      // nickname from the linkage) labels the whole player.
      ...(linked
        ? {
            mergedIdentities: linked.identities,
            revealedName: linked.revealedName || doc.revealedName || null,
          }
        : {}),
      ...(mmrOverlay ? { mmr: mmrOverlay.mmr } : {}),
      ...(mmrOverlay && (doc.region == null || doc.region === "")
        ? { region: mmrOverlay.region }
        : {}),
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
      phases,
      transitions,
      last5Games,
      last5GamesScouting,
      gamesScouting,
      gamesTruncated,
      games: filteredGames,
    };
  }

  /**
   * Upsert from a parsed game. Aggregates win/loss + opening counts.
   *
   * @param {string} userId
   * @param {{
   *   pulseId: string,
   *   gameId?: string,
   *   toonHandle?: string,
   *   pulseCharacterId?: string,
   *   pulseLookupAttempted?: boolean,
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
    // Read the prior row first so we can (a) log a structured change
    // line when a fresh pulseCharacterId replaces a stale one and
    // (b) decide whether this incoming game is the most-recent-by-date
    // we've ever seen for this opponent (see the displayNameSample
    // guard below). The single $setOnInsert/$set/$inc upsert below
    // stays atomic — the pre-read is advisory only and a missing
    // prior row is expected on the first encounter.
    const prior = await this.db.opponents.findOne(
      { userId, pulseId: game.pulseId },
      {
        projection: {
          pulseCharacterId: 1,
          lastSeen: 1,
          mmr: 1,
          mmrFetchedAt: 1,
          region: 1,
          toonHandle: 1,
        },
      },
    );
    // displayNameSample / displayNameHash / lastSeen track the
    // CURRENT name (and CURRENT activity timestamp) for this
    // opponent. Definition: "displayName / playedAt of the
    // max-date game we've ingested for this (userId, pulseId)".
    //
    // Out-of-order uploads (agent backfilling old replays, user
    // dragging in an archive folder) must NOT overwrite these
    // fields with the older game's data — otherwise the Opponents
    // tab heading flips to a stale historical name (the bug this
    // guard fixes). We compare playedAt against the existing
    // lastSeen on the row; if the incoming game is older, we
    // suppress all three fields and keep what the row already
    // stores.
    //
    // First-ever ingest (no prior row): treat as the latest by
    // definition — there's nothing newer to preserve.
    const priorLastSeen = prior && prior.lastSeen instanceof Date
      ? prior.lastSeen
      : null;
    const isLatestByDate = !priorLastSeen || game.playedAt >= priorLastSeen;
    /** @type {Record<string, any>} */
    const setOnInsert = {
      userId,
      pulseId: game.pulseId,
    };
    /** @type {Record<string, any>} */
    const set = { _schemaVersion: OPPONENTS_VERSION };
    if (isLatestByDate) {
      set.displayNameHash = displayHash;
      set.displayNameSample = game.displayName || "";
      set.lastSeen = game.playedAt;
      set.race = game.race;
      if (typeof game.mmr === "number") set.mmr = game.mmr;
      if (typeof game.leagueId === "number") set.leagueId = game.leagueId;
    }
    // Region: derived from the toon_handle's leading byte (always
    // present from sc2reader). Cheap, no network. Pulse fetch below
    // may overwrite with the authoritative region from SC2Pulse's
    // team membership when reachable.
    const derivedRegion = regionFromToonHandle(
      game.toonHandle || (prior && prior.toonHandle) || null,
    );
    if (derivedRegion) set.region = derivedRegion;
    // SC2Pulse current-MMR fetch. Region-aware: passes the derived
    // region as ``preferredRegion`` so a multi-region opponent
    // (the rare smurf-on-EU case) returns the team that matches the
    // game's server, not whichever team SC2Pulse touched most
    // recently. Rate-limit-friendly: skipped when the row carries a
    // recent fetch within MMR_PULSE_FRESH_MS.
    const pulseCharIdForMmr =
      (typeof game.pulseCharacterId === "string" && game.pulseCharacterId)
        ? game.pulseCharacterId
        : (prior && typeof prior.pulseCharacterId === "string"
          ? prior.pulseCharacterId
          : null);
    const toonForMmr =
      (typeof game.toonHandle === "string" && game.toonHandle)
        ? game.toonHandle
        : (prior && typeof prior.toonHandle === "string"
          ? prior.toonHandle
          : null);
    // ``pulseLookupAttempted:false`` is the agent's explicit historical
    // backfill signal. Keep the cheap region/identity write, but leave live
    // SC2Pulse network work to the bounded cloud cron instead of multiplying
    // external calls inside a large /games batch. Fresh games send true and
    // retain immediate opponent enrichment; older agents omit the field and
    // retain their previous behavior.
    const pulseFetched = game.pulseLookupAttempted === false
      ? null
      : await this._fetchOpponentMmrFromPulse(
        pulseCharIdForMmr,
        prior,
        derivedRegion,
        toonForMmr,
      );
    if (pulseFetched) {
      set.mmr = pulseFetched.mmr;
      set.mmrFetchedAt = new Date();
      if (pulseFetched.region) set.region = pulseFetched.region;
      // SC2Pulse "revealed" name (proNickname). Sticky: only written
      // when present so a later barcode-vs-barcode game can't blank a
      // reveal we already captured. Re-check / refresh is the backfill
      // cron's job.
      if (pulseFetched.revealedName) set.revealedName = pulseFetched.revealedName;
    }
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
      {
        $setOnInsert: setOnInsert,
        $set: set,
        $min: { firstSeen: game.playedAt },
        $inc: inc,
      },
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
    await this._stampGameRegion(userId, game.gameId, game, set);
    return {
      upgraded: Boolean(pulseCharIdChange),
      from: pulseCharIdChange ? pulseCharIdChange.from : null,
      to: pulseCharIdChange ? pulseCharIdChange.to : null,
      // Surface opponent-row values to callers. Game-level Pulse MMR
      // is owned by opponentMmrEnrichmentJob and its one-shot marker.
      mmr: typeof set.mmr === "number" ? set.mmr : null,
      region: typeof set.region === "string" ? set.region : null,
    };
  }

  /**
   * Reverse cached opponent counters for legacy games that were newly
   * quarantined as Resume-from-Replay artifacts.
   *
   * Counter reversal and first/last-seen cleanup carry separate durable
   * pending bits. The opponent row receives a game-id token in the same
   * atomic update as its decrement, making counter retries exactly-once.
   * Boundary cleanup remains retryable until every derived metadata write
   * succeeds, so a failure after the decrement cannot leave a synthetic
   * lastSeen/name behind permanently.
   *
   * @param {string} userId
   * @returns {Promise<number>} number of pending game repairs completed
   */
  async repairResumedReplayCountersForUser(userId) {
    const pending = await this.db.games
      .find(
        {
          userId,
          isResumedFromReplay: true,
          $or: [
            { resumedReplayCounterRepairPending: true },
            { resumedReplayBoundaryRepairPending: true },
          ],
        },
        {
          projection: {
            _id: 1,
            gameId: 1,
            date: 1,
            result: 1,
            oppPulseId: 1,
            opponent: 1,
            resumedReplayCounterRepairPending: 1,
            resumedReplayBoundaryRepairPending: 1,
          },
        },
      )
      .toArray();
    if (pending.length === 0) return 0;

    /** @type {Map<string, {dates: Date[], rowIds: any[]}>} */
    const boundaryByPulseId = new Map();
    /** @type {any[]} */
    const boundaryNoopRowIds = [];
    const completedRowIds = new Set();
    for (const game of pending) {
      const nestedPulseId = game?.opponent?.pulseId;
      const pulseId =
        typeof nestedPulseId === "string" && nestedPulseId
          ? nestedPulseId
          : (typeof game.oppPulseId === "string" && game.oppPulseId
            ? game.oppPulseId
            : null);
      const gameId =
        typeof game.gameId === "string" && game.gameId
          ? game.gameId
          : String(game._id);

      if (game.resumedReplayCounterRepairPending === true && pulseId) {
        /** @type {Record<string, any>} */
        const corrected = {
          gameCount: decrementFloorExpr("$gameCount", 1),
          _resumeReplayCounterRepairIds: {
            $setUnion: [
              { $ifNull: ["$_resumeReplayCounterRepairIds", []] },
              [gameId],
            ],
          },
        };
        const result = String(game.result || "").toLowerCase();
        if (result === "victory" || result === "win") {
          corrected.wins = decrementFloorExpr("$wins", 1);
        } else if (result === "defeat" || result === "loss") {
          corrected.losses = decrementFloorExpr("$losses", 1);
        }
        const opening = game?.opponent?.opening;
        if (typeof opening === "string" && opening) {
          const openingPath = `openings.${sanitizeKey(opening)}`;
          corrected[openingPath] = decrementFloorExpr(`$${openingPath}`, 1);
        }

        await this.db.opponents.updateOne(
          {
            userId,
            pulseId,
            _resumeReplayCounterRepairIds: { $ne: gameId },
          },
          [{ $set: corrected }],
        );
      }

      // Marking the game after the atomic opponent update makes an ambiguous
      // network failure safe: the retained opponent token suppresses a second
      // decrement on retry, then this completion write can finish normally.
      if (game.resumedReplayCounterRepairPending === true) {
        await this.db.games.updateOne(
          {
            _id: game._id,
            userId,
            resumedReplayCounterRepairPending: true,
          },
          {
            $set: {
              resumedReplayCounterRepairPending: false,
              resumedReplayCounterRepairedAt: new Date(),
            },
          },
        );
        completedRowIds.add(String(game._id));
      }

      if (game.resumedReplayBoundaryRepairPending === true) {
        const playedAt = game.date instanceof Date
          ? game.date
          : new Date(game.date);
        if (!pulseId || Number.isNaN(playedAt.getTime())) {
          // No opponent identity/date means this game could not have supplied
          // a cached first/last-seen boundary. Complete that independent work
          // item without blocking counter repair.
          boundaryNoopRowIds.push(game._id);
          continue;
        }
        const group = boundaryByPulseId.get(pulseId) || {
          dates: [],
          rowIds: [],
        };
        group.dates.push(playedAt);
        group.rowIds.push(game._id);
        boundaryByPulseId.set(pulseId, group);
      }
    }

    if (boundaryNoopRowIds.length > 0) {
      await this.db.games.updateMany(
        {
          _id: { $in: boundaryNoopRowIds },
          userId,
          resumedReplayBoundaryRepairPending: true,
        },
        {
          $set: {
            resumedReplayBoundaryRepairPending: false,
            resumedReplayBoundaryRepairedAt: new Date(),
          },
        },
      );
      for (const rowId of boundaryNoopRowIds) {
        completedRowIds.add(String(rowId));
      }
    }

    // Repair first/last-seen only when the cached boundary still points at a
    // removed session. Conditional writes preserve a concurrent real game's
    // newer metadata. A resume-only identity is removed with a gameCount
    // guard; a concurrent real ingest either prevents that delete or safely
    // recreates the row with its own metadata and counter. Clear the boundary
    // work item only AFTER these writes succeed; retrying the whole group is
    // idempotent if a previous attempt failed part-way through.
    for (const [pulseId, boundary] of boundaryByPulseId) {
      const competitive = {
        userId,
        isResumedFromReplay: { $ne: true },
        $or: [
          { "opponent.pulseId": pulseId },
          { oppPulseId: pulseId },
        ],
      };
      const [oldest, newest] = await Promise.all([
        this.db.games.findOne(competitive, {
          projection: { _id: 0, date: 1, opponent: 1 },
          sort: { date: 1 },
        }),
        this.db.games.findOne(competitive, {
          projection: { _id: 0, date: 1, opponent: 1 },
          sort: { date: -1 },
        }),
      ]);
      if (!newest) {
        await this.db.opponents.deleteOne(
          { userId, pulseId, gameCount: { $lte: 0 } },
        );
      } else {
        const newestAt = newest.date instanceof Date
          ? newest.date
          : new Date(newest.date);
        if (!Number.isNaN(newestAt.getTime())) {
          /** @type {Record<string, any>} */
          const latestDerived = { lastSeen: newestAt };
          if (newest?.opponent?.displayName) {
            latestDerived.displayNameSample = newest.opponent.displayName;
            latestDerived.displayNameHash = hmac(
              this.pepper,
              newest.opponent.displayName,
            );
          }
          if (newest?.opponent?.race) latestDerived.race = newest.opponent.race;
          await this.db.opponents.updateOne(
            { userId, pulseId, lastSeen: { $in: boundary.dates } },
            { $set: latestDerived },
          );
        }
        const oldestAt = oldest?.date instanceof Date
          ? oldest.date
          : new Date(oldest?.date);
        if (!Number.isNaN(oldestAt.getTime())) {
          await this.db.opponents.updateOne(
            { userId, pulseId, firstSeen: { $in: boundary.dates } },
            { $set: { firstSeen: oldestAt } },
          );
        }
      }

      await this.db.games.updateMany(
        {
          _id: { $in: boundary.rowIds },
          userId,
          resumedReplayBoundaryRepairPending: true,
        },
        {
          $set: {
            resumedReplayBoundaryRepairPending: false,
            resumedReplayBoundaryRepairedAt: new Date(),
          },
        },
      );
      for (const rowId of boundary.rowIds) {
        completedRowIds.add(String(rowId));
      }
    }
    return completedRowIds.size;
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
   *   gameId?: string,
   *   toonHandle?: string,
   *   pulseCharacterId?: string,
   *   pulseLookupAttempted?: boolean,
   *   displayName?: string,
   *   race: string,
   *   mmr?: number,
   *   leagueId?: number,
   *   playedAt: Date,
   * }} game
   */
  async refreshMetadata(userId, game) {
    if (!game.pulseId) throw new Error("pulseId required");
    // A legacy agent may re-upload an already-quarantined resume artifact
    // without sending the newer resume metadata. GamesService preserves the
    // server-owned quarantine flag, so consult that durable row before this
    // advisory refresh can restore its synthetic name/lastSeen/MMR onto the
    // competitive opponent aggregate.
    if (typeof game.gameId === "string" && game.gameId) {
      const quarantined = await this.db.games.findOne(
        {
          userId,
          gameId: game.gameId,
          isResumedFromReplay: true,
        },
        { projection: { _id: 1 } },
      );
      if (quarantined) {
        return {
          matched: 0,
          modified: 0,
          upgraded: false,
          mmr: null,
          region: null,
        };
      }
    }
    const prior = await this.db.opponents.findOne(
      { userId, pulseId: game.pulseId },
      {
        projection: {
          pulseCharacterId: 1,
          lastSeen: 1,
          mmr: 1,
          mmrFetchedAt: 1,
          region: 1,
          toonHandle: 1,
        },
      },
    );
    // Same guard as recordGame: displayNameSample / displayNameHash /
    // lastSeen reflect the most-recent-by-date game, NOT the most
    // recent UPLOAD. Re-uploads of older replays must not flip the
    // Opponents tab heading to a stale historical name.
    const priorLastSeen = prior && prior.lastSeen instanceof Date
      ? prior.lastSeen
      : null;
    const isLatestByDate = !priorLastSeen || game.playedAt >= priorLastSeen;
    /** @type {Record<string, any>} */
    const set = { _schemaVersion: OPPONENTS_VERSION };
    if (isLatestByDate) {
      set.displayNameHash = hmac(this.pepper, game.displayName || "");
      set.displayNameSample = game.displayName || "";
      set.lastSeen = game.playedAt;
      set.race = game.race;
      if (typeof game.mmr === "number") set.mmr = game.mmr;
      if (typeof game.leagueId === "number") set.leagueId = game.leagueId;
    }
    // Region + Pulse-current MMR. Same contract as recordGame: derive
    // region cheaply from the toon_handle leading byte and try one
    // rate-limited SC2Pulse fetch for the up-to-date MMR.
    const refreshDerivedRegion = regionFromToonHandle(
      game.toonHandle || (prior && prior.toonHandle) || null,
    );
    if (refreshDerivedRegion) set.region = refreshDerivedRegion;
    const refreshPulseCharId =
      (typeof game.pulseCharacterId === "string" && game.pulseCharacterId)
        ? game.pulseCharacterId
        : (prior && typeof prior.pulseCharacterId === "string"
          ? prior.pulseCharacterId
          : null);
    const refreshToonForMmr =
      (typeof game.toonHandle === "string" && game.toonHandle)
        ? game.toonHandle
        : (prior && typeof prior.toonHandle === "string"
          ? prior.toonHandle
          : null);
    const refreshPulseFetched = game.pulseLookupAttempted === false
      ? null
      : await this._fetchOpponentMmrFromPulse(
        refreshPulseCharId,
        prior,
        refreshDerivedRegion,
        refreshToonForMmr,
      );
    if (refreshPulseFetched) {
      set.mmr = refreshPulseFetched.mmr;
      set.mmrFetchedAt = new Date();
      if (refreshPulseFetched.region) set.region = refreshPulseFetched.region;
      if (refreshPulseFetched.revealedName) {
        set.revealedName = refreshPulseFetched.revealedName;
      }
    }
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
    await this._stampGameRegion(userId, game.gameId, game, set);
    return {
      matched: res.matchedCount || 0,
      modified: res.modifiedCount || 0,
      upgraded: Boolean(pulseCharIdChange),
      // Same opponent-row-only contract as recordGame.
      mmr: typeof set.mmr === "number" ? set.mmr : null,
      region: typeof set.region === "string" ? set.region : null,
    };
  }

  /**
   * Stamp stable region metadata onto the just-ingested game. Current
   * SC2Pulse MMR deliberately does not flow through this path: the
   * bounded enrichment job is the sole server-side writer of game-level
   * Pulse MMR and owns the one-shot attempt marker.
   *
   * @private
   * @param {string} userId
   * @param {string|undefined} gameId
   * @param {Record<string, any>} incomingGame
   * @param {Record<string, any>} set The opponents-row $set we just wrote.
   * @returns {Promise<void>}
   */
  async _stampGameRegion(userId, gameId, incomingGame, set) {
    if (typeof gameId !== "string" || !gameId) return;
    if (typeof incomingGame.region === "string") return;
    if (typeof set.region !== "string") return;
    try {
      await this.db.games.updateOne(
        { userId, gameId },
        { $set: { "opponent.region": set.region } },
      );
    } catch (err) {
      this.logger.warn(
        { err, userId, gameId },
        "opponent_game_region_stamp_failed",
      );
    }
  }

  /**
   * Copy stable identity metadata from a newly-resolved opponent row to
   * its games. This intentionally excludes MMR: historical Pulse MMR
   * restamps are forbidden, and recent rows are handled by the bounded
   * enrichment job only when their own subdocument carries the id.
   *
   * @private
   * @param {string} userId
   * @param {string} pulseId
   * @param {Record<string, any>} set The opponents-row $set just written.
   * @returns {Promise<number>}
   */
  async _backfillGameIdentity(userId, pulseId, set) {
    /** @type {Record<string, string>} */
    const update = {};
    if (typeof set.region === "string") {
      update["opponent.region"] = set.region;
    }
    if (typeof set.pulseCharacterId === "string") {
      update["opponent.pulseCharacterId"] = set.pulseCharacterId;
    }
    if (Object.keys(update).length === 0) return 0;
    try {
      const res = await this.db.games.updateMany(
        {
          userId,
          "opponent.pulseId": pulseId,
        },
        { $set: update },
      );
      return res.modifiedCount || 0;
    } catch (err) {
      this.logger.warn(
        { err, userId, pulseId },
        "opponent_pulse_backfill_game_identity_failed",
      );
      return 0;
    }
  }

  /**
   * Best-effort SC2Pulse current-MMR fetch for one opponent. Called
   * from recordGame / refreshMetadata on every game ingest. The
   * existing 5-minute in-process cache in PulseMmrService plus the
   * per-row freshness window cap the rate to ~one outbound request
   * per opponent per ``MMR_PULSE_FRESH_MS`` interval — well within
   * SC2Pulse's tolerance even on a bulk re-upload of a day's replay
   * folder.
   *
   * Returns ``null`` (and writes nothing) when:
   *   * the service was constructed without a pulseMmr dependency;
   *   * we don't have a numeric pulseCharacterId for the opponent
   *     (toon-only rows can't be looked up by Pulse directly);
   *   * the prior row's mmrFetchedAt is inside the freshness window;
   *   * the SC2Pulse call returns null (no team in any region) or
   *     throws (rate-limited / network error / timeout).
   *
   * Region-aware: when ``preferredRegion`` is set (the opponent's
   * derived region from toon_handle) and pulseMmr exposes the
   * multi-id ``getCurrentMmrForAny`` shape, we prefer the team that
   * matches the game's server. Falls back to the legacy single-id
   * ``getCurrentMmr`` (which picks the most-recently-played team
   * across regions) when only that method is available.
   *
   * @private
   * @param {string|null} pulseCharacterId
   * @param {Record<string, any>|null} prior the opponents-row pre-read
   *   (or null on first encounter / forced paths); only ``mmrFetchedAt``
   *   is consulted here, for the freshness window.
   * @param {string|null} [preferredRegion]
   * @param {string|null} [toonHandle]
   * @param {{ forceFresh?: boolean }} [opts] when ``forceFresh`` is set
   *   (the admin "Retry" button) we skip the shared-cache READ and the
   *   per-row freshness window so the pull genuinely hits SC2Pulse — but
   *   still write the fresh result THROUGH to the shared cache so every
   *   user gets the refreshed value.
   * @returns {Promise<{mmr: number, region: string|null, revealedName?: string|null}|null>}
   *   ``revealedName`` is only present on a live SC2Pulse pull — the
   *   shared-directory fast path returns just ``mmr`` / ``region``, and
   *   its callers treat the absent field as "no reveal captured".
   */
  async _fetchOpponentMmrFromPulse(pulseCharacterId, prior, preferredRegion, toonHandle, opts = {}) {
    const forceFresh = opts && opts.forceFresh === true;
    const charId =
      typeof pulseCharacterId === "string" && pulseCharacterId.length > 0
        ? pulseCharacterId
        : null;
    const toon =
      typeof toonHandle === "string" && toonHandle.length > 0
        ? toonHandle
        : null;
    // Nothing to query with. Note: a toon handle alone is enough —
    // SC2Pulse's /character/search resolves it to a character id, so a
    // toon-only opponent (pulseCharacterId never resolved) still gets a
    // number instead of a permanent "—".
    if (!charId && !toon) return null;
    // Shared cross-user cache FIRST — a cheap local Mongo read that
    // costs no SC2Pulse round-trip. If another platform user pulled
    // this opponent's MMR within the directory's freshness window we
    // reuse it, which is the whole point of the shared layer (and it
    // even bypasses this user's per-row freshness window, so a stale
    // row gets re-stamped from a peer's fresh pull). Skipped on a
    // forced refresh so the admin "Retry" always hits SC2Pulse live.
    if (this.pulseDirectory && !forceFresh) {
      const shared = await this._directoryGetMmr(charId, toon);
      if (shared && typeof shared.mmr === "number" && shared.mmr > 0) {
        return { mmr: Math.round(shared.mmr), region: shared.region || null };
      }
    }
    if (!this.pulseMmr) return null;
    const lastFetched = prior && prior.mmrFetchedAt instanceof Date
      ? prior.mmrFetchedAt.getTime()
      : null;
    if (lastFetched && Date.now() - lastFetched < MMR_PULSE_FRESH_MS) {
      return null;
    }
    try {
      let result = null;
      if (charId) {
        if (
          typeof this.pulseMmr.getCurrentMmrForAny === "function"
          && preferredRegion
        ) {
          result = await this.pulseMmr.getCurrentMmrForAny(
            [charId],
            { preferredRegion },
          );
        } else {
          result = await this.pulseMmr.getCurrentMmr(charId);
        }
      } else if (typeof this.pulseMmr.getCurrentMmrByToon === "function") {
        result = await this.pulseMmr.getCurrentMmrByToon(toon);
      }
      if (!result) return null;
      const mmr = Number(result.mmr);
      if (!Number.isFinite(mmr) || mmr <= 0) return null;
      const region = typeof result.region === "string" ? result.region : null;
      // SC2Pulse "revealed" identity (proNickname) — the human name
      // behind a barcode when the community linked it to a known
      // pro/main. Surfaced alongside MMR because the same /group/team
      // pull already carries it; callers persist it onto the opponents
      // row so the Opponents tab / overlay can label the bars.
      const revealedName =
        typeof result.revealedName === "string" && result.revealedName
          ? result.revealedName
          : null;
      // Write-through to the shared cache so the next user who runs
      // into this opponent reuses this pull. Best-effort — a directory
      // write failure must never fail the ingest path.
      if (this.pulseDirectory) {
        await this._directoryRecordMmr({
          pulseCharacterId: charId,
          toonHandle: toon,
          mmr: Math.round(mmr),
          region,
        });
      }
      return { mmr: Math.round(mmr), region, revealedName };
    } catch {
      return null;
    }
  }

  /**
   * Read fresh shared MMR, swallowing any directory fault so a cache
   * error degrades to a live SC2Pulse pull rather than throwing into
   * ingest.
   *
   * @private
   * @param {string|null} charId
   * @param {string|null} toon
   * @returns {Promise<{mmr: number|null, region: string|null, races: any[]}|null>}
   */
  async _directoryGetMmr(charId, toon) {
    if (!this.pulseDirectory) return null;
    try {
      return await this.pulseDirectory.getFreshMmr({
        pulseCharacterId: charId,
        toonHandle: toon,
      });
    } catch (err) {
      this.logger.warn({ err }, "opponent_pulse_directory_read_failed");
      return null;
    }
  }

  /**
   * Write-through shared MMR / race breakdown, swallowing errors.
   *
   * @private
   * @param {{
   *   pulseCharacterId?: string|null,
   *   toonHandle?: string|null,
   *   mmr?: number|null,
   *   region?: string|null,
   *   races?: any[]|null,
   * }} args
   * @returns {Promise<void>}
   */
  async _directoryRecordMmr(args) {
    if (!this.pulseDirectory) return;
    try {
      await this.pulseDirectory.recordMmr(args);
    } catch (err) {
      this.logger.warn({ err }, "opponent_pulse_directory_write_failed");
    }
  }

  /**
   * Find opponent rows belonging to ``userId`` whose
   * ``pulseCharacterId`` is missing or empty AND whose
   * ``toonHandle`` is set, then attempt to resolve each one against
   * SC2Pulse. Successful resolutions are persisted; misses bump
   * ``pulseResolveAttemptedAt`` so we don't re-hit Pulse on every
   * subsequent tick.
   *
   * On hit we ALSO fetch the opponent's current SC2Pulse MMR (now
   * that we finally have an id to query with) and back-stamp it
   * onto games against them that DON'T already carry an in-replay
   * MMR. The agent's in-replay value is the at-game-time truth and
   * is always preserved — pulse only fills gaps (games where the
   * replay didn't carry one and the SC2Pulse fetch was skipped at
   * first ingest because the opponent had no pulseCharacterId
   * yet). Without this hop, those barcode-opponent games stay in
   * the chart's "missing MMR" rollup forever. Fail-soft per row:
   * an MMR-fetch or re-stamp failure logs and the cycle continues.
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
      /** @type {Record<string, any>} */
      const set = {
        pulseResolveAttemptedAt: now,
      };
      if (typeof pulseCharacterId === "string" && pulseCharacterId.length > 0) {
        set.pulseCharacterId = pulseCharacterId;
        resolved += 1;
        // Now that we finally have a pulseCharacterId, fetch the
        // opponent's current SC2Pulse MMR. Region: derive from
        // toon_handle as a cheap fallback; pulse overwrites with
        // the authoritative team region on hit.
        const derivedRegion = regionFromToonHandle(toon);
        if (derivedRegion) set.region = derivedRegion;
        // prior=null so the freshness window doesn't suppress this
        // fetch — we JUST resolved the id and want the value now.
        let pulseFetched = null;
        try {
          pulseFetched = await this._fetchOpponentMmrFromPulse(
            pulseCharacterId,
            null,
            derivedRegion,
          );
        } catch (err) {
          this.logger.warn(
            { err, userId, pulseId: row.pulseId, pulseCharacterId },
            "opponent_pulse_backfill_mmr_fetch_failed",
          );
        }
        if (pulseFetched) {
          set.mmr = pulseFetched.mmr;
          set.mmrFetchedAt = now;
          if (pulseFetched.region) set.region = pulseFetched.region;
          // We just made a live /group/team pull, so we know this
          // opponent's reveal status — stamp it and store the
          // proNickname when present. Saves the reveal re-check pass a
          // round-trip for a freshly-resolved row.
          set.revealedNameCheckedAt = now;
          if (pulseFetched.revealedName) {
            set.revealedName = pulseFetched.revealedName;
          }
        }
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
        // Heal stable identity metadata only. Current Pulse MMR never
        // back-stamps prior games; the recent-row enrichment job owns
        // that bounded, race-correct write from this deploy forward.
        await this._backfillGameIdentity(userId, row.pulseId, set);
      }
    }
    return { scanned: rows.length, resolved, updated, skipped };
  }

  /**
   * Re-check SC2Pulse "revealed" identity for opponents we've ALREADY
   * resolved to a pulseCharacterId.
   *
   * Why a separate pass from ``backfillPulseCharacterId``: a barcode's
   * reveal (the community linking the anonymised account to a known
   * pro/main on sc2pulse.nephest.com) can land at ANY time after we
   * first recorded the opponent — long after their pulseCharacterId was
   * resolved. The id-backfill cron only touches rows whose
   * ``pulseCharacterId`` is still empty, so without this pass a
   * reveal that happens post-resolution would never surface in the
   * Opponents tab / overlay. Here we re-probe resolved rows whose
   * ``revealedNameCheckedAt`` is missing or older than the re-check
   * window, force a live ``/group/team`` pull (which carries the
   * member's ``proNickname``), and persist any reveal we find.
   *
   * Throttled by ``revealedNameCheckedAt`` so a non-revealed opponent
   * (the overwhelming majority) is re-probed at most once per window
   * rather than every cycle — keeping us under SC2Pulse's shared rate
   * limit. Opportunistically refreshes MMR while the team data is in
   * hand.
   *
   * No-op (returns zeroes) when the service was built without a
   * ``pulseMmr`` dependency — there's nothing to query SC2Pulse with.
   *
   * @param {string} userId
   * @param {{ limit?: number, recheckSec?: number, force?: boolean }} [opts]
   * @returns {Promise<{scanned: number, revealed: number, updated: number}>}
   */
  async backfillRevealedNames(userId, opts = {}) {
    if (!userId) throw new Error("userId required");
    if (!this.pulseMmr) return { scanned: 0, revealed: 0, updated: 0 };
    const limit = clampLimit(opts.limit, 50);
    const recheckSec =
      typeof opts.recheckSec === "number" && opts.recheckSec >= 0
        ? opts.recheckSec
        : 24 * 60 * 60;
    const cutoff = new Date(Date.now() - recheckSec * 1000);
    /** @type {Record<string, any>} */
    const filter = {
      userId,
      pulseCharacterId: { $type: "string", $ne: "" },
    };
    if (!opts.force) {
      filter.$or = [
        { revealedNameCheckedAt: { $exists: false } },
        { revealedNameCheckedAt: null },
        { revealedNameCheckedAt: { $lt: cutoff } },
      ];
    }
    const rows = await this.db.opponents
      .find(filter, {
        projection: {
          _id: 0,
          pulseId: 1,
          pulseCharacterId: 1,
          toonHandle: 1,
          region: 1,
          revealedName: 1,
        },
      })
      .limit(limit)
      .toArray();
    let revealed = 0;
    let updated = 0;
    for (const row of rows) {
      const charId =
        typeof row.pulseCharacterId === "string" ? row.pulseCharacterId : "";
      if (!charId) continue;
      const toon =
        typeof row.toonHandle === "string" && row.toonHandle
          ? row.toonHandle
          : null;
      const region =
        typeof row.region === "string" && row.region
          ? row.region
          : regionFromToonHandle(toon);
      const now = new Date();
      /** @type {Record<string, any>} */
      const set = { revealedNameCheckedAt: now };
      let pulseFetched = null;
      try {
        // forceFresh: bypass the shared-cache read AND the per-row
        // freshness window so we genuinely pull /group/team and see the
        // current proNickname (a reveal that landed since the last
        // check).
        pulseFetched = await this._fetchOpponentMmrFromPulse(
          charId,
          null,
          region,
          toon,
          { forceFresh: true },
        );
      } catch (err) {
        this.logger.warn(
          { err, userId, pulseId: row.pulseId, pulseCharacterId: charId },
          "opponent_revealed_name_fetch_failed",
        );
      }
      if (pulseFetched) {
        if (typeof pulseFetched.mmr === "number") {
          set.mmr = pulseFetched.mmr;
          set.mmrFetchedAt = now;
        }
        if (pulseFetched.region) set.region = pulseFetched.region;
        if (
          pulseFetched.revealedName
          && pulseFetched.revealedName !== row.revealedName
        ) {
          set.revealedName = pulseFetched.revealedName;
          revealed += 1;
          this.logger.info(
            {
              userId,
              pulseId: row.pulseId,
              pulseCharacterId: charId,
              from: row.revealedName || null,
              to: pulseFetched.revealedName,
            },
            "opponent_revealed_name_resolved",
          );
        }
      }
      const res = await this.db.opponents.updateOne(
        { userId, pulseId: row.pulseId },
        { $set: set },
      );
      if (res.modifiedCount > 0) updated += 1;
    }
    return { scanned: rows.length, revealed, updated };
  }

  /**
   * Admin diagnostics for ONE opponent: why is the Pulse ID and/or MMR
   * missing? Read-only — reads the opponents row plus a cheap count of
   * how many games carry an in-replay ``opponent.mmr`` — and turns the
   * stored identity/MMR state into a human-readable list of findings.
   *
   * No SC2Pulse traffic: everything is inferred from fields already
   * persisted at ingest / backfill time (``pulseCharacterId``,
   * ``toonHandle``, ``mmr``, ``mmrFetchedAt``, ``pulseResolveAttemptedAt``).
   * That's why the debug panel needs no agent update.
   *
   * @param {string} userId
   * @param {string} pulseId
   * @returns {Promise<null | {
   *   pulseId: string,
   *   toonHandle: string|null,
   *   pulseCharacterId: string|null,
   *   displayNameSample: string|null,
   *   region: string|null,
   *   mmr: number|null,
   *   mmrFetchedAt: string|null,
   *   pulseResolveAttemptedAt: string|null,
   *   leagueId: number|null,
   *   gameCount: number,
   *   inReplayMmrCount: number,
   *   pulseIdStatus: "resolved"|"unresolved"|"none",
   *   mmrStatus: "present"|"missing",
   *   findings: Array<{code: string, severity: string, message: string}>,
   * }>}
   */
  async diagnoseIdentity(userId, pulseId) {
    if (!userId) throw new Error("userId required");
    if (typeof pulseId !== "string" || !pulseId) throw new Error("pulseId required");
    const row = await this.db.opponents.findOne(
      { userId, pulseId },
      {
        projection: {
          _id: 0,
          pulseId: 1,
          toonHandle: 1,
          pulseCharacterId: 1,
          displayNameSample: 1,
          region: 1,
          mmr: 1,
          mmrFetchedAt: 1,
          pulseResolveAttemptedAt: 1,
          leagueId: 1,
          gameCount: 1,
        },
      },
    );
    if (!row) return null;
    const inReplayMmrCount = await this.db.games.countDocuments({
      userId,
      isResumedFromReplay: { $ne: true },
      "opponent.pulseId": pulseId,
      "opponent.mmr": { $type: "number" },
    });

    const charId =
      typeof row.pulseCharacterId === "string" && row.pulseCharacterId.length > 0
        ? row.pulseCharacterId
        : null;
    const toon =
      typeof row.toonHandle === "string" && row.toonHandle.length > 0
        ? row.toonHandle
        : null;
    const name =
      typeof row.displayNameSample === "string" ? row.displayNameSample : "";
    const hasMmr = typeof row.mmr === "number" && row.mmr > 0;
    const attemptedAt =
      row.pulseResolveAttemptedAt instanceof Date
        ? row.pulseResolveAttemptedAt
        : null;
    const fetchedAt =
      row.mmrFetchedAt instanceof Date ? row.mmrFetchedAt : null;

    /** @type {Array<{code: string, severity: string, message: string}>} */
    const findings = [];
    /**
     * @param {string} code
     * @param {string} severity
     * @param {string} message
     */
    const add = (code, severity, message) =>
      findings.push({ code, severity, message });

    // --- Pulse ID ---
    /** @type {"resolved"|"unresolved"|"none"} */
    let pulseIdStatus;
    if (charId) {
      pulseIdStatus = "resolved";
      add(
        "pulse_id_resolved",
        "ok",
        `Resolved to SC2Pulse character id ${charId} — the "Pulse ID" column links to nephest.`,
      );
    } else if (toon) {
      pulseIdStatus = "unresolved";
      add(
        "pulse_id_unresolved",
        "warn",
        `Only the raw toon handle (${toon}) is known — SC2Pulse never confirmed a character id, so the column shows "TOON" instead of a link.`,
      );
      if (attemptedAt) {
        add(
          "pulse_resolve_attempted",
          "info",
          `Resolution was attempted (last ${attemptedAt.toISOString()}) but no candidate matched this toon's bnid. SC2Pulse may have been unreachable, or the name search returned no confident match. The miss is negative-cached; "Retry" forces a fresh attempt.`,
        );
      } else {
        add(
          "pulse_resolve_not_attempted",
          "info",
          "Resolution hasn't been attempted yet — the backfill cron hasn't reached this opponent. \"Retry\" forces it now.",
        );
      }
      if (isBarcodeLikeName(name)) {
        add(
          "pulse_resolve_barcode",
          "warn",
          `Display name "${name}" is a barcode (indistinguishable glyphs), so name-based search is unreliable for this opponent.`,
        );
      }
    } else {
      pulseIdStatus = "none";
      add(
        "pulse_id_none",
        "warn",
        "No toon handle and no character id on record — there's nothing to query SC2Pulse with. This row predates identity capture or was rebuilt from games without an opponent toon handle.",
      );
    }

    // --- MMR ---
    const mmrStatus = hasMmr ? "present" : "missing";
    if (hasMmr) {
      const src = fetchedAt
        ? `from SC2Pulse (last fetched ${fetchedAt.toISOString()})`
        : inReplayMmrCount > 0
          ? "from an in-replay value"
          : "from a stored value";
      add("mmr_present", "ok", `MMR ${row.mmr} on record ${src}.`);
    } else {
      if (inReplayMmrCount === 0) {
        add(
          "mmr_no_in_replay",
          "info",
          "No recorded game carried an in-replay opponent MMR — normal for ranked 1v1, where sc2reader doesn't expose the opponent's MMR.",
        );
      }
      if (!charId && !toon) {
        add(
          "mmr_no_id",
          "warn",
          "No id to query SC2Pulse with, so the current-ladder MMR can't be fetched.",
        );
      } else if (fetchedAt) {
        add(
          "mmr_pulse_empty",
          "warn",
          `SC2Pulse was queried (last ${fetchedAt.toISOString()}) but returned no current 1v1 team — the opponent likely hasn't played ranked 1v1 this season, or the lookup was rate-limited.`,
        );
      } else {
        add(
          "mmr_pulse_not_fetched",
          "info",
          "SC2Pulse MMR hasn't been fetched yet for this opponent. It'll be tried on the next backfill, or use \"Retry\" to fetch now.",
        );
      }
    }

    return {
      pulseId: row.pulseId,
      toonHandle: toon,
      pulseCharacterId: charId,
      displayNameSample: name || null,
      region: typeof row.region === "string" ? row.region : null,
      mmr: hasMmr ? row.mmr : null,
      mmrFetchedAt: fetchedAt ? fetchedAt.toISOString() : null,
      pulseResolveAttemptedAt: attemptedAt ? attemptedAt.toISOString() : null,
      leagueId: typeof row.leagueId === "number" ? row.leagueId : null,
      gameCount: typeof row.gameCount === "number" ? row.gameCount : 0,
      inReplayMmrCount,
      pulseIdStatus,
      mmrStatus,
      findings,
    };
  }

  /**
   * Force a fresh SC2Pulse resolve + MMR refetch for ONE opponent,
   * bypassing the throttle windows the cron respects. Powers the admin
   * debug panel's "Retry" button. Unlike ``backfillPulseCharacterId``
   * (which only touches rows MISSING a character id), this also
   * refetches MMR when the id is already resolved but the MMR is
   * missing — and falls back to a toon-handle MMR lookup when no
   * character id can be resolved at all.
   *
   * @param {string} userId
   * @param {string} pulseId
   * @returns {Promise<null | {
   *   resolvedPulseCharacterId: boolean,
   *   pulseCharacterId: string|null,
   *   mmr: number|null,
   *   region: string|null,
   *   gamesRestamped: number,
   * }>}
   */
  async retryPulseResolution(userId, pulseId) {
    if (!userId) throw new Error("userId required");
    if (typeof pulseId !== "string" || !pulseId) throw new Error("pulseId required");
    const row = await this.db.opponents.findOne(
      { userId, pulseId },
      {
        projection: {
          _id: 0,
          pulseId: 1,
          toonHandle: 1,
          pulseCharacterId: 1,
          displayNameSample: 1,
        },
      },
    );
    if (!row) return null;
    const toon =
      typeof row.toonHandle === "string" && row.toonHandle.length > 0
        ? row.toonHandle
        : null;
    let charId =
      typeof row.pulseCharacterId === "string" && row.pulseCharacterId.length > 0
        ? row.pulseCharacterId
        : null;

    const now = new Date();
    /** @type {Record<string, any>} */
    const set = { pulseResolveAttemptedAt: now };
    let resolvedNow = false;

    // Step 1 — resolve a character id if we don't have one yet.
    if (!charId && toon && this.pulseResolver) {
      try {
        const resolved = await this.pulseResolver.resolve({
          toonHandle: toon,
          displayName:
            typeof row.displayNameSample === "string"
              ? row.displayNameSample
              : "",
          forceRefresh: true,
        });
        if (typeof resolved === "string" && resolved.length > 0) {
          charId = resolved;
          set.pulseCharacterId = resolved;
          resolvedNow = true;
        }
      } catch (err) {
        this.logger.warn(
          { err, userId, pulseId, toonHandle: toon },
          "opponent_pulse_retry_resolver_failed",
        );
      }
    }

    const derivedRegion = regionFromToonHandle(toon);
    if (derivedRegion) set.region = derivedRegion;

    // Step 2 — fetch MMR. ``forceFresh`` bypasses BOTH the per-row
    // freshness window AND the shared-cache read so a manual retry
    // always hits SC2Pulse live; the fresh value is still written
    // through to the shared cache, so this one admin click refreshes
    // the opponent for every user who tracks them. Uses the character
    // id if we have one, else the toon-handle fallback.
    let pulseFetched = null;
    try {
      pulseFetched = await this._fetchOpponentMmrFromPulse(
        charId,
        null,
        derivedRegion,
        toon,
        { forceFresh: true },
      );
    } catch (err) {
      this.logger.warn(
        { err, userId, pulseId, pulseCharacterId: charId },
        "opponent_pulse_retry_mmr_fetch_failed",
      );
    }
    if (pulseFetched) {
      set.mmr = pulseFetched.mmr;
      set.mmrFetchedAt = now;
      if (pulseFetched.region) set.region = pulseFetched.region;
    }

    await this.db.opponents.updateOne({ userId, pulseId }, { $set: set });

    // Step 3 — heal stable game identity metadata only. A manual admin
    // retry may refresh the opponent profile's current MMR, but it must
    // not turn into an unbounded historical game-MMR backfill.
    const gamesRestamped = await this._backfillGameIdentity(
      userId,
      pulseId,
      { region: set.region, pulseCharacterId: charId },
    );

    this.logger.info(
      { userId, pulseId, resolvedNow, pulseCharacterId: charId, mmr: set.mmr ?? null },
      "opponent_pulse_retry",
    );

    return {
      resolvedPulseCharacterId: resolvedNow,
      pulseCharacterId: charId,
      mmr: typeof set.mmr === "number" ? set.mmr : null,
      region: typeof set.region === "string" ? set.region : null,
      gamesRestamped,
    };
  }

  /**
   * Per-race SC2Pulse 1v1 MMR breakdown for one of the caller's
   * opponents, plus ``topRace`` / ``topMmr`` (their highest-rated race)
   * for the profile header.
   *
   * Live SC2Pulse fetch (cached 5 min in PulseMmrService). Returns
   * ``resolved: false`` with an empty ``races`` array when the
   * opponent has no resolved id / toon, or SC2Pulse is unreachable —
   * the UI then falls back to the single stored MMR.
   *
   * @param {string} userId
   * @param {string} pulseId
   * @returns {Promise<null | {
   *   resolved: boolean,
   *   races: Array<{race: string, mmr: number, games: number, league: string|null, region: string|null}>,
   *   topRace: string|null,
   *   topMmr: number|null,
   * }>}
   */
  async getPulseRaceBreakdown(userId, pulseId) {
    if (!userId) throw new Error("userId required");
    if (typeof pulseId !== "string" || !pulseId) throw new Error("pulseId required");
    const row = await this.db.opponents.findOne(
      { userId, pulseId },
      {
        projection: {
          _id: 0,
          pulseId: 1,
          pulseCharacterId: 1,
          toonHandle: 1,
          region: 1,
        },
      },
    );
    if (!row) return null;

    /** @type {string[]} */
    const ids = [];
    if (typeof row.pulseCharacterId === "string" && row.pulseCharacterId) {
      ids.push(row.pulseCharacterId);
    }
    if (typeof row.toonHandle === "string" && row.toonHandle) {
      ids.push(row.toonHandle);
    }

    const charId =
      typeof row.pulseCharacterId === "string" && row.pulseCharacterId
        ? row.pulseCharacterId
        : null;
    const toon =
      typeof row.toonHandle === "string" && row.toonHandle
        ? row.toonHandle
        : null;

    /** @type {Array<{race: string, mmr: number, games: number, league: string|null, region: string|null}>} */
    let races = [];

    // Shared cross-user cache first: a per-race breakdown another user
    // already pulled for this opponent is served without any SC2Pulse
    // traffic, so a profile opened for the first time by THIS user
    // still renders the full table instantly.
    if (this.pulseDirectory && (charId || toon)) {
      const shared = await this._directoryGetMmr(charId, toon);
      if (shared && Array.isArray(shared.races) && shared.races.length > 0) {
        races = shared.races;
      }
    }

    if (
      races.length === 0
      && ids.length > 0
      && this.pulseMmr
      && typeof this.pulseMmr.getRaceBreakdown === "function"
    ) {
      // The opponent's characterId lives in exactly one region, so hand
      // the breakdown a region hint (authoritative from the toon handle,
      // falling back to the stored region) — it then queries only that
      // region's current season instead of all four.
      const preferredRegion =
        regionFromToonHandle(row.toonHandle)
        || (typeof row.region === "string" ? row.region : null);
      try {
        races = (await this.pulseMmr.getRaceBreakdown(ids, { preferredRegion })) || [];
      } catch {
        races = [];
      }
      // Write-through so the next viewer reuses this breakdown.
      if (this.pulseDirectory && races.length > 0) {
        await this._directoryRecordMmr({
          pulseCharacterId: charId,
          toonHandle: toon,
          mmr: races[0].mmr,
          region: races[0].region,
          races,
        });
      }
    }

    const top = races.length > 0 ? races[0] : null;
    return {
      resolved: races.length > 0,
      races,
      topRace: top ? top.race : null,
      topMmr: top ? top.mmr : null,
    };
  }
}

/**
 * Lightweight barcode-name detector for the diagnostics panel — names
 * built entirely from visually indistinguishable glyphs (I, l, 1, i, |
 * and common unicode lookalikes). Mirrors ``isBarcodeName`` in the web
 * ``lib/sc2pulse.ts`` so the API's "why didn't name search work" hint
 * matches what the UI considers a barcode.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isBarcodeLikeName(name) {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  return /^[Il1i|ⅠΙＩｌｉ１｜]+$/u.test(trimmed);
}

/**
 * Grouping key for a SC2Pulse character link. ``proId`` (community-
 * verified player, spans accounts) wins over ``accountId`` (same
 * Battle.net login); no linkage → null → the row never merges.
 * Mirrors the web's ``groupKey`` in ``lib/opponentGroups.ts`` so the
 * list's grouping and the merged profile agree on who is one player.
 *
 * @param {{ proId?: string|null, accountId?: string|null } | null | undefined} link
 * @returns {string|null}
 */
function linkGroupKey(link) {
  if (!link) return null;
  if (link.proId) return `pro:${link.proId}`;
  if (link.accountId) return `acct:${link.accountId}`;
  return null;
}

/** @param {{ lastSeen?: unknown }} row @returns {number} */
function lastSeenMs(row) {
  return row && row.lastSeen instanceof Date ? row.lastSeen.getTime() : 0;
}

/**
 * Public shape of one identity inside a merged profile's
 * ``mergedIdentities`` array. Lifetime counters straight off the
 * opponents row; ``name`` is the latest-game name (post-overlay).
 *
 * @param {Record<string, any>} r opponents-collection row
 */
function serializeLinkedIdentity(r) {
  return {
    pulseId: String(r.pulseId),
    pulseCharacterId:
      typeof r.pulseCharacterId === "string" ? r.pulseCharacterId : null,
    toonHandle: typeof r.toonHandle === "string" ? r.toonHandle : null,
    name: typeof r.displayNameSample === "string" ? r.displayNameSample : "",
    revealedName:
      typeof r.revealedName === "string" && r.revealedName
        ? r.revealedName
        : null,
    wins: Number(r.wins) || 0,
    losses: Number(r.losses) || 0,
    games: Number(r.gameCount) || 0,
    lastSeen: r.lastSeen instanceof Date ? r.lastSeen : null,
  };
}

/**
 * The merged profile's heading name — the player's "most known" name:
 *   1. the SC2Pulse revealed/pro name when the group carries one;
 *   2. else the readable (non-barcode) name with the most games;
 *   3. else the most-played name even if it's a barcode.
 * Ties go to the more recently seen identity (rows arrive newest
 * first). Mirrors ``pickDisplayName`` in the web's opponentGroups so
 * the list row and its deep dive lead with the same name.
 *
 * @param {Array<{ displayNameSample?: unknown, gameCount?: unknown }>} identities
 *   opponent rows sorted by lastSeen desc
 * @param {string|null} revealedName
 * @returns {string|null}
 */
function pickMergedMainName(identities, revealedName) {
  if (revealedName) return revealedName;
  /** @type {{name: string, games: number}|null} */
  let best = null;
  /** @type {{name: string, games: number}|null} */
  let bestBarcode = null;
  for (const r of identities) {
    const name =
      typeof r.displayNameSample === "string" ? r.displayNameSample.trim() : "";
    if (!name) continue;
    const games = Number(r.gameCount) || 0;
    if (isBarcodeLikeName(name)) {
      if (!bestBarcode || games > bestBarcode.games) {
        bestBarcode = { name, games };
      }
    } else if (!best || games > best.games) {
      best = { name, games };
    }
  }
  const picked = best || bestBarcode;
  return picked ? picked.name : null;
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
 * Mongo update-pipeline expression for subtracting a cached counter without
 * allowing legacy inconsistencies to produce a negative value.
 *
 * @param {string} fieldPath aggregation field reference (for example "$wins")
 * @param {number} amount
 * @returns {Record<string, any>}
 */
function decrementFloorExpr(fieldPath, amount) {
  return {
    $max: [
      0,
      { $subtract: [{ $ifNull: [fieldPath, 0] }, amount] },
    ],
  };
}

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

/** @param {unknown} raw @returns {number} */
function clampOpponentGamesLimit(raw) {
  const fallback = LIMITS.OPPONENT_GAMES_PAGE_SIZE || 200;
  const ceiling = LIMITS.OPPONENT_GAMES_LIST_MAX || fallback;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, ceiling);
}

/**
 * @param {string} pulseId
 * @param {Record<string, any>} doc
 * @param {{pulseIds: string[], characterIds: string[]}|null} linked
 * @returns {Record<string, any>}
 */
function profileGamesIdentityFilter(pulseId, doc, linked) {
  if (linked) {
    return {
      $or: [
        { "opponent.pulseId": { $in: linked.pulseIds } },
        {
          "opponent.pulseCharacterId": {
            $in: linked.characterIds,
          },
        },
      ],
    };
  }
  return opponentGamesFilter({
    pulseId,
    pulseCharacterId: doc.pulseCharacterId,
  }) || { "opponent.pulseId": pulseId };
}

/**
 * @param {unknown} raw
 * @returns {{date: Date, id: import('mongodb').ObjectId}|null}
 */
function decodeOpponentGamesCursor(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.length > 512) {
    throw invalidOpponentGamesCursor();
  }
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!parsed || parsed.v !== 1 || typeof parsed.d !== "string") {
      throw invalidOpponentGamesCursor();
    }
    const date = new Date(parsed.d);
    const idText = typeof parsed.i === "string" ? parsed.i.toLowerCase() : "";
    if (
      Number.isNaN(date.getTime())
      || !ObjectId.isValid(idText)
      || new ObjectId(idText).toHexString() !== idText
    ) {
      throw invalidOpponentGamesCursor();
    }
    return { date, id: new ObjectId(idText) };
  } catch (err) {
    const known = /** @type {{code?: unknown}|null} */ (err);
    if (known && known.code === "bad_request") throw err;
    throw invalidOpponentGamesCursor();
  }
}

/** @param {unknown} date @param {unknown} id @returns {string} */
function encodeOpponentGamesCursor(date, id) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error("opponent_games_cursor_date_missing");
  }
  const objectId = id instanceof ObjectId ? id : new ObjectId(String(id));
  return Buffer.from(
    JSON.stringify({ v: 1, d: date.toISOString(), i: objectId.toHexString() }),
    "utf8",
  ).toString("base64url");
}

/** @returns {Error & {status?: number, code?: string}} */
function invalidOpponentGamesCursor() {
  const err = /** @type {Error & {status: number, code: string}} */ (
    new Error("invalid opponent games cursor")
  );
  err.status = 400;
  err.code = "bad_request";
  return err;
}

/**
 * True if any filter that invalidates the cached opponent counters is
 * set. When true, ``list`` re-aggregates from the games collection via
 * ``_listFiltered`` (which runs ``gamesMatchStage``) instead of serving
 * the lifetime counters off the opponents collection.
 *
 * ``regions`` is deliberately absent: it rides the unfiltered fast path
 * with its own two-tier match (see ``list``), since region doesn't
 * change a per-opponent total. ``mapPool`` and ``gameSize`` DO change
 * totals (they slice games by map / player count), and those fields
 * live on the games documents — not the opponents collection — so they
 * must force the aggregation path or they'd be silently ignored.
 *
 * @param {import('../util/parseQuery').GlobalFilters | null | undefined} f
 * @returns {boolean}
 */
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
      || f.build
      || f.leak
      || typeof f.macroMin === "number"
      || typeof f.macroMax === "number"
      || f.excludeTooShort
      || f.mapPool
      || f.gameSize,
  );
}

/**
 * Normalise a stored game document into the shape consumed by the
 * legacy SPA profile renderers (lowercase ISO date string,
 * `opp_strategy`, `opp_race`, `my_build`, `game_length`).
 *
 * @param {any} g Mongo games-collection doc (post detail hydration).
 */
function serializeGameForProfile(g) {
  if (!g) return g;
  const opp = g.opponent || {};
  const replaySizeBytes =
    Number.isFinite(g.replayFile?.sizeBytes) && g.replayFile.sizeBytes > 0
      ? g.replayFile.sizeBytes
      : null;
  // ``macroBreakdown`` is hydrated onto rawGames so the phase
  // classifier can read it server-side, but the profile JSON envelope
  // emits only the compact phase aggregates — drop the raw blob here
  // so it doesn't bloat the response.
  const rest = { ...g };
  delete rest.macroBreakdown;
  delete rest.replayFile;
  return {
    ...rest,
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
    replayAvailable:
      replaySizeBytes !== null && Boolean(g.replayFile?.storedAt),
    replayFilename: null,
    replaySizeBytes,
  };
}

/**
 * Strict allow-list serializer for cursor-paged replay rows. Keeping this
 * separate from `serializeGameForProfile` prevents newly-added slim/detail
 * fields from accidentally inflating the full-history response.
 *
 * @param {any} g
 * @returns {object}
 */
function serializeCompactProfileGame(g) {
  const opp = g && g.opponent && typeof g.opponent === "object"
    ? g.opponent
    : {};
  const replaySizeBytes =
    Number.isFinite(g?.replayFile?.sizeBytes) && g.replayFile.sizeBytes > 0
      ? g.replayFile.sizeBytes
      : null;
  return {
    id: g?.gameId || null,
    date: g?.date instanceof Date ? g.date.toISOString() : g?.date || null,
    result: g?.result || "",
    map: g?.map || "",
    opponent: opp.displayName || "",
    opp_race: opp.race || "",
    opp_strategy: opp.strategy || null,
    my_build: g?.myBuild || "",
    my_race: g?.myRace || "",
    game_length: g?.durationSec || 0,
    macro_score: typeof g?.macroScore === "number" ? g.macroScore : null,
    my_mmr: typeof g?.myMmr === "number" ? g.myMmr : null,
    opp_mmr: typeof opp.mmr === "number" ? opp.mmr : null,
    replayAvailable:
      replaySizeBytes !== null && Boolean(g?.replayFile?.storedAt),
    replayFilename: null,
    replaySizeBytes,
  };
}

/**
 * Apply every analyzer filter except the date window to an in-memory
 * profile game set. Opponent profiles load a bounded, identity-scoped
 * history first because the latest unfiltered row is still needed for
 * identity and MMR display; this matcher keeps all statistical panels in
 * lock-step with gamesMatchStage without making those identity fields
 * filter-dependent.
 *
 * @param {Array<any>} games
 * @param {import('../util/parseQuery').GlobalFilters | null | undefined} f
 * @returns {Array<any>}
 */
function filterGamesByAnalyzerScope(games, f) {
  if (!f || typeof f !== "object") return games;
  return games.filter((g) => {
    if (!g || typeof g !== "object") return false;
    const opp = g.opponent || {};

    if (f.race && canonicalRaceLetter(g.myRace) !== f.race) return false;
    if (f.oppRace && canonicalRaceLetter(opp.race) !== f.oppRace) {
      return false;
    }
    if (
      f.map
      && !String(g.map || "").toLowerCase().includes(String(f.map).toLowerCase())
    ) {
      return false;
    }

    if (typeof f.mmrMin === "number" || typeof f.mmrMax === "number") {
      const mmr = opp.mmr;
      // Mongo's numeric range predicates use type bracketing: a numeric
      // string or null does not match a numeric $gte/$lte constraint.
      if (typeof mmr !== "number" || !Number.isFinite(mmr)) return false;
      if (typeof f.mmrMin === "number" && mmr < f.mmrMin) return false;
      if (typeof f.mmrMax === "number" && mmr > f.mmrMax) return false;
    }
    if (f.oppStrategy && opp.strategy !== f.oppStrategy) return false;
    if (f.build && g.myBuild !== f.build) return false;

    if (f.leak) {
      const leaks = Array.isArray(g.top3Leaks) ? g.top3Leaks : [];
      if (!leaks.some((/** @type {any} */ leak) => leak && leak.name === f.leak)) {
        return false;
      }
    }
    if (typeof f.macroMin === "number" || typeof f.macroMax === "number") {
      const score = g.macroScore;
      if (typeof score !== "number" || !Number.isFinite(score)) return false;
      if (typeof f.macroMin === "number" && score < f.macroMin) return false;
      // Exclusive upper bound, matching gamesMatchStage.
      if (typeof f.macroMax === "number" && score >= f.macroMax) return false;
    }

    if (f.excludeTooShort) {
      if (!f.build && /Game Too Short$/.test(String(g.myBuild || ""))) {
        return false;
      }
      if (
        !f.oppStrategy
        && /Game Too Short$/.test(String(opp.strategy || ""))
      ) {
        return false;
      }
    }

    if (Array.isArray(f.regions) && f.regions.length > 0) {
      const storedRegion = typeof opp.region === "string" && opp.region
        ? opp.region
        : null;
      const region = storedRegion || regionFromToonHandle(opp.toonHandle);
      if (!region || !f.regions.includes(region)) return false;
    }

    // Ranked/custom is an authoritative replay classification, not a map
    // name proxy. Unknown legacy rows deliberately fall out of both
    // explicit buckets instead of letting custom games on ladder maps in.
    if (f.mapPool === "ladder" && g.isLadderGame !== true) return false;
    if (f.mapPool === "nonladder" && g.isLadderGame !== false) return false;

    // A two-player count is a safe fallback for legacy 1v1 rows. Counts
    // above two are not sufficient evidence of a team match because FFA
    // has the same shape, so Team requires the normalized format.
    if (f.gameSize === "1v1") {
      const isLegacyOneVsOne =
        !Object.prototype.hasOwnProperty.call(g, "matchFormat")
        && g.playerCount === 2;
      if (g.matchFormat !== "1v1" && !isLegacyOneVsOne) return false;
    }
    if (f.gameSize === "team" && g.matchFormat !== "team") return false;

    return true;
  });
}

/**
 * Whether a profile request carries any filter that makes falling back to
 * lifetime opponent counters incorrect when the matched game set is empty.
 *
 * @param {import('../util/parseQuery').GlobalFilters | null | undefined} f
 * @returns {boolean}
 */
function hasProfileFilters(f) {
  if (!f || typeof f !== "object") return false;
  return hasFilters(f)
    || Boolean(
      f.leak
      || typeof f.macroMin === "number"
      || typeof f.macroMax === "number"
      || f.excludeTooShort
      || (Array.isArray(f.regions) && f.regions.length > 0),
    );
}

/**
 * Restrict a games array to those whose `date` falls inside the
 * inclusive [since, until] range. Either bound can be omitted. Games
 * without a valid stored Date are excluded when a bound is active,
 * matching Mongo's Date range type-bracketing in gamesMatchStage.
 *
 * @param {Array<any>} games
 * @param {Date|undefined} since
 * @param {Date|undefined} until
 * @returns {Array<any>}
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
    if (!g || !(g.date instanceof Date)) return false;
    const t = g.date.getTime();
    if (Number.isNaN(t)) return false;
    if (sinceMs !== null && t < sinceMs) return false;
    if (untilMs !== null && t > untilMs) return false;
    return true;
  });
}

/**
 * Aggregate W/L by map and by opponent strategy from the games array.
 *
 * @param {Array<any>} games profile-serialized games (``opp_strategy``
 *   / ``map`` / ``result`` fields).
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
 *
 * @param {Array<any>} games
 * @param {any} doc opponents-collection row (or null-ish).
 * @returns {{wins: number, losses: number, total: number, winRate: number}}
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
 *
 * @param {any} legacy ``Record<token, TokenTimingRow>`` map from
 *   dnaTimings (``any`` so the null-tolerant ``legacy[k]`` reads keep
 *   their runtime shape).
 * @returns {Record<string, {key: string, median: number|null, count: number}>}
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
 * @param {Record<string, any>} doc opponents-collection row (Mongo doc;
 *   ``toonHandle`` / ``pulseId`` are the fields read).
 * @returns {string[]}
 */
function collectMergedToonHandles(rawGames, doc) {
  const seen = new Set();
  /** @type {string[]} */
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

/**
 * Per-matchup projection of ``projectMedianTimings`` — maps each
 * ``{ timings }`` bucket through the same compat shape.
 *
 * @param {any} legacy ``Record<matchup, {timings, order}>`` map (``any``
 *   for the same null-tolerant reads as ``projectMedianTimings``).
 * @returns {Record<string, Record<string, {key: string, median: number|null, count: number}>>}
 */
function projectMatchupTimings(legacy) {
  /** @type {Record<string, Record<string, {key: string, median: number|null, count: number}>>} */
  const out = {};
  for (const ml of Object.keys(legacy || {})) {
    out[ml] = projectMedianTimings(legacy[ml] && legacy[ml].timings);
  }
  return out;
}

/**
 * Group games by opponent strategy and compute a full phase composition
 * envelope per strategy. Powers the per-strategy "Opening / Mid / Late"
 * detail rows under each phase tab on the opponent profile.
 *
 * Output is sorted by total games desc and capped at ``maxStrategies``
 * to bound payload size; smaller strategy buckets fall through to the
 * aggregate ``perPhase`` above.
 *
 * @param {Array<any>} games
 * @param {{ perspective?: "you"|"opponent", maxStrategies?: number }} [opts]
 * @returns {Array<{
 *   strategy: string,
 *   race: string|null,
 *   games: number,
 *   wins: number,
 *   losses: number,
 *   winRate: number,
 *   phases: ReturnType<typeof computeCompositions>,
 * }>}
 */
function computeByStrategyPhases(games, opts = {}) {
  const list = Array.isArray(games) ? games : [];
  const perspective = opts.perspective === "opponent" ? "opponent" : "you";
  const cap = Math.max(1, Math.floor(opts.maxStrategies || 6));

  /** @type {Map<string, { strategy: string, race: string|null, games: any[], wins: number, losses: number }>} */
  const groups = new Map();

  for (const g of list) {
    if (!g) continue;
    const raw =
      (g.opponent && g.opponent.strategy) || g.opp_strategy || "";
    const strategy = raw ? String(raw).trim() : "Unknown";
    if (!strategy) continue;
    const race =
      perspective === "opponent"
        ? (g.oppRace || (g.opponent && g.opponent.race) || null)
        : (g.myRace || null);
    let bucket = groups.get(strategy);
    if (!bucket) {
      bucket = {
        strategy,
        race: race ? String(race) : null,
        games: [],
        wins: 0,
        losses: 0,
      };
      groups.set(strategy, bucket);
    }
    bucket.games.push(g);
    // Win/loss attribution from the user's perspective. Mirrors the
    // ``aggregateByMapAndStrategy`` helper above so the cards agree
    // with the by-strategy panel.
    const result = (g.result || "").toString().toLowerCase();
    if (result === "win" || result === "victory") bucket.wins += 1;
    else if (result === "loss" || result === "defeat") bucket.losses += 1;
  }

  const buckets = Array.from(groups.values())
    .sort((a, b) => b.games.length - a.games.length)
    .slice(0, cap);

  return buckets.map((b) => {
    const wins = b.wins;
    const losses = b.losses;
    const denom = wins + losses;
    return {
      strategy: b.strategy,
      race: b.race,
      games: b.games.length,
      wins,
      losses,
      winRate: denom > 0 ? wins / denom : 0,
      phases: computeCompositions(b.games, { perspective }),
    };
  });
}

module.exports = { OpponentsService };
