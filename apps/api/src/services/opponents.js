"use strict";

const { LIMITS, COLLECTIONS } = require("../config/constants");
const { hmac } = require("../util/hash");
const { expectedVersion } = require("../db/schemaVersioning");
const { gamesMatchStage } = require("../util/parseQuery");
const { opponentGamesFilter } = require("../util/opponentIdentity");
const { regionFromToonHandle } = require("../util/regionFromToonHandle");
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
    // Optional SC2Pulse MMR client (the same one GamesService and the
    // session widget already share). When supplied, recordGame /
    // refreshMetadata attempt one rate-limited fetch per ingest to
    // populate ``mmr`` and ``region`` on the opponents row AND return
    // them so the games-route caller can stamp them onto the
    // ``game.opponent.mmr`` / ``game.opponent.region`` sub-document
    // (the bingo MMR predicates and any other game-level consumer
    // read from there). sc2reader almost never carries an opponent's
    // MMR for ranked 1v1 ladder replays, so SC2Pulse is the only
    // viable source. Best-effort: a Pulse failure leaves the prior
    // value untouched and the next encounter retries.
    this.pulseMmr = opts.pulseMmr || null;
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
   * In-place overlay of ``mmr`` / ``region`` from the opponent's most
   * recent game that actually carries those fields. Self-healing for
   * the gap the Pulse-fill-at-ingest path leaves behind:
   *
   *   * If sc2reader extracted an opponent MMR for some game in the
   *     past, ``game.opponent.mmr`` is set on that row even though
   *     the opponents collection's ``mmr`` field may still be null
   *     (rows pre-date the propagation guard, OR the ingest path
   *     skipped the Pulse fetch because ``pulseCharacterId`` wasn't
   *     resolved yet and was only filled in later by the backfill
   *     cron).
   *   * If the cloud-side Pulse fetch ever succeeded on a recent
   *     game ingest, that game's ``opponent.mmr`` carries the value
   *     authoritatively.
   *
   * Either way the data is already in our database — we just have to
   * read it. Crucially this is a PURE-DATABASE overlay: zero outbound
   * SC2Pulse traffic, so it adds no rate-limit pressure and runs on
   * every list page without coordination.
   *
   * One aggregation per page. Uses the
   * ``{opponent.pulseId, userId, date}`` index for the sort. Safe on
   * an empty page; safe when every row already carries an ``mmr``
   * (the ``$in`` set ends up empty and the aggregation short-circuits).
   *
   * Only overlays when the row's stored ``mmr`` is missing —
   * non-null stored values are authoritative (they came from
   * ``recordGame``'s SC2Pulse fetch, which beats anything the agent
   * happened to extract from sc2reader).
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
    const needIds = [];
    for (const r of rows) {
      if (!r || typeof r.pulseId !== "string" || r.pulseId.length === 0) {
        continue;
      }
      if (typeof r.mmr === "number") continue;
      needIds.push(r.pulseId);
    }
    if (needIds.length === 0) return;
    const cursor = this.db.games.aggregate([
      {
        $match: {
          userId,
          "opponent.pulseId": { $in: needIds },
          "opponent.mmr": { $type: "number" },
        },
      },
      { $sort: { date: -1 } },
      {
        $group: {
          _id: "$opponent.pulseId",
          mmr: { $first: "$opponent.mmr" },
          region: { $first: "$opponent.region" },
        },
      },
    ]);
    /** @type {Map<string, {mmr: number, region?: string|null}>} */
    const byPulseId = new Map();
    for await (const doc of cursor) {
      if (typeof doc._id !== "string") continue;
      const mmr = Number(doc.mmr);
      if (!Number.isFinite(mmr) || mmr <= 0) continue;
      byPulseId.set(doc._id, {
        mmr: Math.round(mmr),
        region: typeof doc.region === "string" ? doc.region : null,
      });
    }
    // Second tier: for any row still without an MMR, fall back to
    // the opponents-collection row's stored ``mmr`` / ``region``.
    // That's where the SC2Pulse current-MMR fetch in ``recordGame``
    // lands — sc2reader almost never carries opponent.mmr for ranked
    // 1v1 replays, so for high-ladder opponents the opponents-row
    // value is the ONLY place we have the number. Without this
    // fallback the filtered Opponents tab silently blanks the MMR
    // column for anyone whose every game in the filter window was
    // missing opponent.mmr (the bug surfaced as "the mmr disappeared
    // for AngryBird"). Mirrors the same fallback the
    // MMR-bucket charts use in trendsInsights.js.
    /** @type {string[]} */
    const stillMissing = [];
    for (const r of rows) {
      if (!r || typeof r.pulseId !== "string") continue;
      if (typeof r.mmr === "number") continue;
      if (byPulseId.has(r.pulseId)) continue;
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
      if (typeof r.mmr === "number") continue;
      const found = byPulseId.get(r.pulseId) || opponentsFallback.get(r.pulseId);
      if (!found) continue;
      r.mmr = found.mmr;
      if (
        (r.region == null || r.region === "")
        && typeof found.region === "string"
      ) {
        r.region = found.region;
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
    const allGames = rawGames.map(serializeGameForProfile);
    const filteredGames = filterGamesByDate(allGames, opts.since, opts.until);
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
    const authoritativeName = latestGameName || doc.displayNameSample || "";
    // Cross-toon merge surfacing: if the rawGames span multiple toon
    // handles (the Battle.net rebind case), expose the merged set so
    // the SPA can render a "merged across N toons" disclosure chip
    // without needing a second round-trip. Single-toon profiles
    // omit this field entirely so the UI shows nothing extra.
    const mergedToonHandles = collectMergedToonHandles(rawGames, doc);
    const aggregates = aggregateByMapAndStrategy(filteredGames);
    const totals = computeTotals(filteredGames, doc);
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
    // ``filterGamesByDate`` reads ``g.date`` via ``new Date(...)``,
    // which works for both Date instances (rawGames) and the ISO
    // strings ``serializeGameForProfile`` emits (allGames). Same
    // window the by-map / by-strategy aggregates use.
    const rawFilteredGames = filterGamesByDate(
      rawGames, opts.since, opts.until,
    );
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
    // Predictions and the most-recent-5 list always reflect the full
    // history — see method jsdoc.
    const predictedStrategies = Dna.recencyWeightedStrategies(allGames);
    const last5Games = allGames.slice(0, 5);
    // Per-game scouting envelopes for the overlay's scouting widget.
    // Operates on the un-serialized rawGames entries (which still
    // carry ``macroBreakdown`` + ``oppBuildLog``) so the per-game
    // build-order strip + composition snapshots have real source
    // data. ``serializeGameForProfile`` strips the heavy blobs from
    // ``allGames``, hence the raw-side traversal here. The compute
    // itself lives in ``scouting/perGameScouting.js`` to keep this
    // file under the 800-line ceiling.
    const last5GamesScouting = rawGames.slice(0, 5).map((g) => {
      try {
        return computePerGameScouting(g);
      } catch (err) {
        console.warn(
          "perGameScouting failed for gameId=%s userId=%s: %s",
          g && g.gameId, userId, (err && err.message) || err,
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
          console.warn(
            "perGameScouting failed for gameId=%s userId=%s: %s",
            g && g.gameId, userId, (err && err.message) || err,
          );
          return null;
        }
      })
      .filter((envelope) => envelope !== null);
    const matchupTimingsLegacy = dna.matchupTimings;
    const matchupTimings = projectMatchupTimings(matchupTimingsLegacy);
    // MMR + region overlay from the most recent game that carries
    // those fields. Same self-healing pattern as the list path: if
    // the opponents row doesn't have ``mmr`` stored (because Pulse
    // was skipped at first ingest or sc2reader carried no value),
    // but a recent game DOES, surface that value on the profile
    // header instead of "—". Pure database read — no Pulse traffic.
    /** @type {{mmr: number, region: string|null}|null} */
    let mmrOverlay = null;
    if (typeof doc.mmr !== "number") {
      for (const g of rawGames) {
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
      firstSeen: game.playedAt,
    };
    /** @type {Record<string, any>} */
    const set = {
      race: game.race,
      _schemaVersion: OPPONENTS_VERSION,
    };
    if (isLatestByDate) {
      set.displayNameHash = displayHash;
      set.displayNameSample = game.displayName || "";
      set.lastSeen = game.playedAt;
    }
    if (typeof game.mmr === "number") set.mmr = game.mmr;
    if (typeof game.leagueId === "number") set.leagueId = game.leagueId;
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
    const pulseFetched = await this._fetchOpponentMmrFromPulse(
      pulseCharIdForMmr,
      prior,
      derivedRegion,
      toonForMmr,
    );
    if (pulseFetched) {
      set.mmr = pulseFetched.mmr;
      set.mmrFetchedAt = new Date();
      if (pulseFetched.region) set.region = pulseFetched.region;
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
    await this._stampGameOpponentMmr(userId, game.gameId, game, set);
    return {
      upgraded: Boolean(pulseCharIdChange),
      from: pulseCharIdChange ? pulseCharIdChange.from : null,
      to: pulseCharIdChange ? pulseCharIdChange.to : null,
      // Surfaced so the games-route can stamp ``opponent.mmr`` /
      // ``opponent.region`` onto the just-upserted games row. The
      // bingo MMR predicates (``win_vs_higher_mmr`` /
      // ``win_close_mmr``) and any other game-level consumer read
      // from ``g.opponent.mmr`` — without this hop the predicates
      // never tick because sc2reader doesn't carry it.
      mmr: typeof set.mmr === "number" ? set.mmr : null,
      region: typeof set.region === "string" ? set.region : null,
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
    const set = {
      race: game.race,
      _schemaVersion: OPPONENTS_VERSION,
    };
    if (isLatestByDate) {
      set.displayNameHash = hmac(this.pepper, game.displayName || "");
      set.displayNameSample = game.displayName || "";
      set.lastSeen = game.playedAt;
    }
    if (typeof game.mmr === "number") set.mmr = game.mmr;
    if (typeof game.leagueId === "number") set.leagueId = game.leagueId;
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
    const refreshPulseFetched = await this._fetchOpponentMmrFromPulse(
      refreshPulseCharId,
      prior,
      refreshDerivedRegion,
      refreshToonForMmr,
    );
    if (refreshPulseFetched) {
      set.mmr = refreshPulseFetched.mmr;
      set.mmrFetchedAt = new Date();
      if (refreshPulseFetched.region) set.region = refreshPulseFetched.region;
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
    await this._stampGameOpponentMmr(userId, game.gameId, game, set);
    return {
      matched: res.matchedCount || 0,
      modified: res.modifiedCount || 0,
      upgraded: Boolean(pulseCharIdChange),
      // Same contract as recordGame: surface the resolved MMR /
      // region so the games-route can stamp them onto the just-
      // upserted games row (the bingo MMR predicates read from
      // ``g.opponent.mmr``).
      mmr: typeof set.mmr === "number" ? set.mmr : null,
      region: typeof set.region === "string" ? set.region : null,
    };
  }

  /**
   * Stamp the just-resolved opponent MMR / region back onto the
   * specific game's ``opponent.mmr`` / ``opponent.region`` sub-doc
   * in the games collection. The bingo MMR predicates
   * (``win_vs_higher_mmr`` / ``win_close_mmr`` in
   * ``arcadePredicates.js``) read from games — without this hop they
   * never tick because sc2reader doesn't carry an opponent's MMR for
   * ranked ladder replays.
   *
   * Only stamps fields the agent didn't supply (``incomingGame.mmr``
   * / ``incomingGame.region``) so an explicit agent-provided value
   * always wins. No-op when ``gameId`` is missing (defensive — the
   * route always passes it but pre-route callers may not).
   *
   * @private
   * @param {string} userId
   * @param {string|undefined} gameId
   * @param {Record<string, any>} incomingGame
   * @param {Record<string, any>} set The opponents-row $set we just wrote.
   * @returns {Promise<void>}
   */
  async _stampGameOpponentMmr(userId, gameId, incomingGame, set) {
    if (typeof gameId !== "string" || !gameId) return;
    /** @type {Record<string, any>} */
    const update = {};
    if (
      typeof incomingGame.mmr !== "number"
      && typeof set.mmr === "number"
    ) {
      update["opponent.mmr"] = set.mmr;
    }
    if (
      typeof incomingGame.region !== "string"
      && typeof set.region === "string"
    ) {
      update["opponent.region"] = set.region;
    }
    if (Object.keys(update).length === 0) return;
    try {
      await this.db.games.updateOne(
        { userId, gameId },
        { $set: update },
      );
    } catch (err) {
      // Stamp failures are advisory (the slim row is already in
      // place; the bingo predicates just won't fire for THIS game
      // until the next ingest re-attempts). Log and move on.
      this.logger.warn(
        { err, userId, gameId },
        "opponent_game_mmr_stamp_failed",
      );
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
   * @param {{mmrFetchedAt?: Date}|null} prior
   * @param {string|null} [preferredRegion]
   * @returns {Promise<{mmr: number, region: string|null}|null>}
   */
  async _fetchOpponentMmrFromPulse(pulseCharacterId, prior, preferredRegion, toonHandle) {
    if (!this.pulseMmr) return null;
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
      return {
        mmr: Math.round(mmr),
        region: typeof result.region === "string" ? result.region : null,
      };
    } catch {
      return null;
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
        // Back-stamp games against this opponent that DON'T already
        // carry an in-replay MMR. The filter on
        // ``opponent.mmr: { $not: { $type: "number" } }`` is the
        // priority guard — the agent's in-replay value is the
        // at-game-time truth and must never be overwritten by
        // pulse's current ladder MMR (which drifts the moment the
        // opponent plays another ranked match). One updateMany so a
        // barcode with 50 prior games becomes one Mongo round-trip,
        // not 50. Uses the {opponent.pulseId, userId, date} index.
        /** @type {Record<string, any>} */
        const gameUpdate = {};
        if (typeof set.mmr === "number") gameUpdate["opponent.mmr"] = set.mmr;
        if (typeof set.region === "string") gameUpdate["opponent.region"] = set.region;
        if (Object.keys(gameUpdate).length > 0) {
          try {
            const gres = await this.db.games.updateMany(
              {
                userId,
                "opponent.pulseId": row.pulseId,
                "opponent.mmr": { $not: { $type: "number" } },
              },
              { $set: gameUpdate },
            );
            if (gres.modifiedCount > 0) {
              this.logger.info(
                {
                  userId,
                  pulseId: row.pulseId,
                  gameCount: gres.modifiedCount,
                },
                "opponent_pulse_backfill_games_restamped",
              );
            }
          } catch (err) {
            this.logger.warn(
              { err, userId, pulseId: row.pulseId },
              "opponent_pulse_backfill_games_restamp_failed",
            );
          }
        }
      }
    }
    return { scanned: rows.length, resolved, updated, skipped };
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

    const findings = [];
    const add = (code, severity, message) =>
      findings.push({ code, severity, message });

    // --- Pulse ID ---
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

    // Step 2 — fetch MMR. prior=null bypasses the freshness window so a
    // manual retry always hits SC2Pulse. Uses the character id if we
    // have one, else the toon-handle fallback.
    let pulseFetched = null;
    try {
      pulseFetched = await this._fetchOpponentMmrFromPulse(
        charId,
        null,
        derivedRegion,
        toon,
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

    // Step 3 — back-stamp games that lack an in-replay MMR, mirroring
    // the backfill cron (the agent's in-replay value always wins).
    let gamesRestamped = 0;
    /** @type {Record<string, any>} */
    const gameUpdate = {};
    if (typeof set.mmr === "number") gameUpdate["opponent.mmr"] = set.mmr;
    if (typeof set.region === "string") gameUpdate["opponent.region"] = set.region;
    if (charId) gameUpdate["opponent.pulseCharacterId"] = charId;
    if (Object.keys(gameUpdate).length > 0) {
      try {
        const gres = await this.db.games.updateMany(
          {
            userId,
            "opponent.pulseId": pulseId,
            "opponent.mmr": { $not: { $type: "number" } },
          },
          { $set: gameUpdate },
        );
        gamesRestamped = gres.modifiedCount || 0;
      } catch (err) {
        this.logger.warn(
          { err, userId, pulseId },
          "opponent_pulse_retry_games_restamp_failed",
        );
      }
    }

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
      || f.mapPool
      || f.gameSize,
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
  // ``macroBreakdown`` is hydrated onto rawGames so the phase
  // classifier can read it server-side, but the profile JSON envelope
  // emits only the compact phase aggregates — drop the raw blob here
  // so it doesn't bloat the response.
  const { macroBreakdown: _macroDrop, ...rest } = g;
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
