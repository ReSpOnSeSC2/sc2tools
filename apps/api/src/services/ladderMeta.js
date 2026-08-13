"use strict";

const { VERSION_KEY } = require("../db/schemaVersioning");
const {
  LADDER_META_BUCKET_WIDTH,
  LADDER_META_LOW_CAP,
  LADDER_META_HIGH_CAP,
  MMR_FLOOR,
  MMR_CEILING,
  isLadderMetaMmrBand,
  ladderMetaBracketLabel,
} = require("../util/mmrBracketing");

/**
 * Ladder Meta Radar — the effectiveness-weighted opener meta report.
 *
 * Where the Spawning Tool shows pro PREVALENCE and SC2Pulse shows race
 * winrates, this shows — from the whole SC2 Tools user corpus — which
 * OPENERS actually WIN, sliced by (opponent band, matchup), with
 * week-over-week movement. The opponent band can be either league or a
 * capped 500-point MMR range. It is the public, SEO-facing counterpart to
 * services/leaguePercentiles.js and is built the same way: one nightly
 * aggregation over the SLIM ``games`` rows into a small collection, a
 * k-anonymity floor before anything is served, and no per-user field in
 * the output.
 *
 * Data source — SLIM ``games`` rows only. The three fields we group on
 * (``opponent.leagueId`` / ``opponent.mmr``, ``myRace`` +
 * ``opponent.race``, ``myBuild``) plus ``result`` all live on the slim row
 * (see validation/gameRecord.js and services/games.js); the heavy
 * ``game_details`` blob is never touched.
 *
 * League banding — slim games rows carry NO "my league" field; the only
 * league signal is ``opponent.leagueId`` (SC2 league enum, stamped by
 * the agent for ladder games). We band by it exactly like
 * leaguePercentiles: SC2 matchmaking pairs near-equal ratings, so the
 * opponent's league is a faithful proxy for the bracket the game was
 * played in. ``leagueBand`` is that numeric id (identity banding — one
 * band per league) and ``league`` is its display label.
 *
 * MMR banding — recent slim rows may carry the forward-enriched
 * ``opponent.mmr`` described by ADR 0019. Ratings in [MMR_FLOOR,
 * MMR_CEILING) are bucketed into half-open 500-point bands, with the low
 * tail collapsed to <2000 and the high tail to 6500+. MMR is always the
 * opponent's rating, preserving the existing league axis's semantics.
 *
 * Matchup — derived from ``myRace`` + ``opponent.race`` first letters
 * ("Protoss" vs "Zerg" -> "PvZ"). Non-P/T/Z races (Random / AI /
 * corrupted rows) and team games (``playerCount`` present and != 2) are
 * excluded.
 *
 * Opener — the classified opener label the agent writes to ``myBuild``.
 * The catch-all "<X>v<Y> - Game Too Short" bucket (replays under 45 s,
 * no build developed — see replay-engine/core/strategy_detector*.py) and
 * empty/missing labels are excluded so the report is about real openings.
 *
 * Week-over-week — each band doc keeps a snapshot of the PREVIOUS run's
 * openers inline (``prevOpeners`` + ``prevUpdatedAt``). ``recompute``
 * reads the current doc's ``openers`` and carries them forward as the
 * new doc's ``prevOpeners`` before overwriting, so ``lookup`` can derive
 * per-opener winrate/frequency deltas without a second collection. Kept
 * inline (rather than a ``ladder_meta_history`` doc) to stay simple and
 * idempotent: re-running on unchanged data leaves the served numbers
 * identical and every delta at 0.
 *
 * Privacy — output rows are aggregates only: no ``userId`` (or any other
 * per-user identifier) is ever projected into the pipeline output or the
 * ``ladder_meta`` collection. ``lookup`` additionally refuses to serve a
 * (band, matchup) whose total sample is below ``MIN_SAMPLE`` games, and
 * only openers with at least ``OPENER_MIN_SAMPLE`` games are stored /
 * served (a per-opener k-anonymity floor).
 *
 * Schema versioning — rows carry the standard ``_schemaVersion`` key
 * (reusing schemaVersioning's VERSION_KEY). ``ladder_meta`` is not yet
 * registered in config/constants COLLECTIONS / the schemaVersioning
 * REGISTRY (that registration is part of the later wiring change,
 * alongside app.js construction); until then the version is stamped
 * literally here so existing rows are already correctly marked when the
 * registry entry lands.
 */

/** Output collection. Accessed via ``db.db.collection(...)`` because it
 *  is not (yet) part of the DbContext handle set in db/connect.js. */
const COLLECTION_NAME = "ladder_meta";

/** k-anonymity-style floor: a (band, matchup) whose total games are
 *  below this is never served by ``lookup``. */
const MIN_SAMPLE = 50;

/** Per-opener floor: openers below this game count are dropped from the
 *  stored/served list — a single-user quirk opener shouldn't surface. */
const OPENER_MIN_SAMPLE = 10;

/** Max openers kept per (band, matchup) row. The tail past this adds
 *  noise, not signal, to a "top openers" report. */
const TOP_N = 12;

/** ``_schemaVersion`` stamped on every output row. */
const SCHEMA_VERSION = 2;

const BAND_TYPE_LEAGUE = "league";
const BAND_TYPE_MMR = "mmr";
const PATCH_ERA_AFTER = "after";
const PATCH_ERA_BEFORE = "before";
/** @type {ReadonlyArray<"after" | "before">} */
const PATCH_ERAS = Object.freeze([PATCH_ERA_AFTER, PATCH_ERA_BEFORE]);
// First live 5.0.16 build. New agent uploads carry the replay's exact build
// and release string, so the meta split follows the game version even when a
// replay's timestamp is skewed. The release instant remains the compatibility
// fallback for rows uploaded before version metadata existed.
const PATCH_5_0_16_BUILD = 97364;
const PATCH_5_0_16_RELEASE = new Date("2026-06-22T19:15:00.000Z");
const BAND_INDEX_KEY = Object.freeze({ era: 1, bandType: 1, band: 1, matchup: 1 });

/** Race initials accepted on either side of the matchup. */
const RACE_LETTERS = Object.freeze(["P", "T", "Z"]);

/** SC2 league enum -> display label. Ids outside the ladder enum fall
 *  back to a generic "League N" label rather than being dropped. */
const LEAGUE_NAMES = Object.freeze({
  0: "Bronze",
  1: "Silver",
  2: "Gold",
  3: "Platinum",
  4: "Diamond",
  5: "Master",
  6: "Grandmaster",
});

/**
 * @typedef {{
 *   build: string,
 *   games: number,
 *   wins: number,
 *   losses: number,
 *   winRate: number,
 *   frequency: number,
 * }} StoredOpener
 *
 * @typedef {StoredOpener & {
 *   winRateDelta: number | null,
 *   freqDelta: number | null,
 *   isNew: boolean,
 * }} ServedOpener
 *
 * @typedef {{
 *   leagueBand: number,
 *   league: string,
 *   matchup: string,
 *   n: number,
 *   openers: ServedOpener[],
 *   updatedAt: Date,
 *   prevUpdatedAt: Date | null,
 * }} MetaRow
 */

class LadderMetaService {
  /**
   * @param {{ games: import('mongodb').Collection, db: import('mongodb').Db }} db
   *        DbContext from db/connect.js (only ``games`` and the raw
   *        ``db`` handle are used).
   * @param {{
   *   logger?: { info: (obj: Record<string, unknown>, msg: string) => void } | null,
   *   now?: () => number,
   * }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.games = db.games;
    this.coll = db.db.collection(COLLECTION_NAME);
    this.logger = opts.logger || null;
    this.now = opts.now || (() => Date.now());
    /** @type {Promise<{
     *   bands: number, leagueBands: number, mmrBands: number, updatedAt: Date
     * }>|null} */
    this.recomputeInFlight = null;
    this.recomputeQueued = false;
    this.lastRecomputeAt = 0;
  }

  /**
   * Rebuild both opponent-band axes with one shared timestamp. Both
   * result sets are written before stale cleanup runs once, so neither
   * axis can erase the other.
   *
   * @returns {Promise<{
   *   bands: number, leagueBands: number, mmrBands: number, updatedAt: Date
   * }>}
   */
  async recompute() {
    if (this.recomputeInFlight) {
      // A repair may finish while the scheduled startup rebuild is still
      // running. Coalesce callers, but queue one fresh pass so the older
      // snapshot can never be the last writer.
      this.recomputeQueued = true;
      return this.recomputeInFlight;
    }
    this.recomputeInFlight = (async () => {
      let result;
      do {
        this.recomputeQueued = false;
        result = await this._recomputeOnce();
      } while (this.recomputeQueued);
      return result;
    })();
    try {
      return await this.recomputeInFlight;
    } finally {
      this.recomputeInFlight = null;
    }
  }

  /**
   * One serialized aggregate pass. Public callers use ``recompute`` so
   * scheduled and enrichment-triggered rebuilds share the same queue.
   *
   * @returns {Promise<{
   *   bands: number, leagueBands: number, mmrBands: number, updatedAt: Date
   * }>}
   */
  async _recomputeOnce() {
    // Queued passes can begin in the same wall-clock millisecond. Keep the
    // derived-cache stamp strictly increasing so stale cleanup can still
    // distinguish and remove rows that vanished between those passes.
    const stamp = Math.max(this.now(), this.lastRecomputeAt + 1);
    this.lastRecomputeAt = stamp;
    const updatedAt = new Date(stamp);
    await migrateBandIndex(this.coll);
    const priorByKey = await readPriorRows(this.coll);
    const aggregates = await Promise.all(
      PATCH_ERAS.flatMap((era) => [
        aggregateRows(this.games, BAND_TYPE_LEAGUE, era),
        aggregateRows(this.games, BAND_TYPE_MMR, era),
      ]),
    );
    const leagueDocs = PATCH_ERAS.flatMap((era, index) =>
      shapeRows(aggregates[index * 2], BAND_TYPE_LEAGUE, era, updatedAt, priorByKey),
    );
    const mmrDocs = PATCH_ERAS.flatMap((era, index) =>
      shapeRows(aggregates[index * 2 + 1], BAND_TYPE_MMR, era, updatedAt, priorByKey),
    );
    const docs = [...leagueDocs, ...mmrDocs];
    await writeRows(this.coll, docs);
    await this.coll.deleteMany({ updatedAt: { $lt: updatedAt } });
    if (this.logger) {
      this.logger.info(
        {
          bands: docs.length,
          leagueBands: leagueDocs.length,
          mmrBands: mmrDocs.length,
          collection: COLLECTION_NAME,
        },
        "ladder_meta_recomputed",
      );
    }
    return {
      bands: docs.length,
      leagueBands: leagueDocs.length,
      mmrBands: mmrDocs.length,
      updatedAt,
    };
  }

  /**
   * Fetch one meta row with week-over-week deltas folded in. Returns
   * ``null`` when the (band, matchup) is unknown OR its total sample is
   * below the ``MIN_SAMPLE`` k-anonymity floor — the caller can't tell
   * the difference, by design.
   *
   * @param {{
   *   bandType?: "league" | "mmr", band?: number,
   *   leagueId?: number, matchup: string, era?: "after" | "before"
   * }} args
   * @returns {Promise<Record<string, any> | null>}
   */
  async lookup(args) {
    const requested = normalizeBandRequest(args);
    const matchup = normalizeMatchup(args.matchup);
    const era = normalizePatchEra(args.era);
    if (!requested || !matchup || !era) return null;
    let row = await this.coll.findOne(
      { era, bandType: requested.bandType, band: requested.band, matchup },
      { projection: { _id: 0 } },
    );
    if (!row || typeof row.n !== "number" || row.n < MIN_SAMPLE) return null;
    return shapeServedRow(row, requested);
  }
}

/**
 * Replace legacy indexes and discard rows without an era. The old rows span
 * both game versions and cannot be assigned safely; this derived cache is
 * rebuilt immediately after migration.
 *
 * @param {import('mongodb').Collection} coll
 */
async function migrateBandIndex(coll) {
  const indexes = await readIndexes(coll);
  for (const index of indexes) {
    if (isObsoleteBandIndex(index) && typeof index.name === "string") {
      await dropIndexIfPresent(coll, index.name);
    }
  }
  await coll.deleteMany({
    $or: [
      { era: { $nin: [...PATCH_ERAS] } },
      { bandType: { $exists: false } },
      { band: { $exists: false } },
      { matchup: { $exists: false } },
    ],
  });
  await coll.createIndex(BAND_INDEX_KEY, { unique: true });
}

/** @param {import('mongodb').Collection} coll @param {string} name */
async function dropIndexIfPresent(coll, name) {
  try {
    await coll.dropIndex(name);
  } catch (err) {
    const mongoErr = /** @type {{code?: number, codeName?: string}} */ (err);
    if (mongoErr.code === 27 || mongoErr.codeName === "IndexNotFound") return;
    throw err;
  }
}

/** @param {import('mongodb').Collection} coll */
async function readIndexes(coll) {
  try {
    return await coll.listIndexes().toArray();
  } catch (err) {
    const mongoErr = /** @type {{code?: number, codeName?: string}} */ (err);
    if (mongoErr.code === 26 || mongoErr.codeName === "NamespaceNotFound") return [];
    throw err;
  }
}

/** @param {Record<string, any>} index */
function isObsoleteBandIndex(index) {
  const key = index && index.key;
  if (!key || typeof key !== "object") return false;
  const fields = Object.keys(key);
  return (
    (fields.length === 2 && key.leagueBand === 1 && key.matchup === 1) ||
    (fields.length === 3 && key.bandType === 1 && key.band === 1 && key.matchup === 1)
  );
}

/**
 * @param {import('mongodb').Collection} coll
 * @returns {Promise<Map<string, { openers: StoredOpener[], updatedAt: Date | null }>>}
 */
async function readPriorRows(coll) {
  const docs = /** @type {any[]} */ (
    await coll.find({}, {
      projection: {
        _id: 0,
        bandType: 1,
        era: 1,
        band: 1,
        leagueBand: 1,
        matchup: 1,
        openers: 1,
        updatedAt: 1,
      },
    }).toArray()
  );
  const prior = new Map();
  for (const doc of docs) {
    const type = doc.bandType === BAND_TYPE_MMR ? BAND_TYPE_MMR : BAND_TYPE_LEAGUE;
    const band = Number.isFinite(doc.band) ? doc.band : doc.leagueBand;
    const era = normalizePatchEra(doc.era);
    if (!era || !Number.isFinite(band) || typeof doc.matchup !== "string") continue;
    prior.set(bandKey(era, type, band, doc.matchup), {
      openers: Array.isArray(doc.openers) ? doc.openers : [],
      updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt : null,
    });
  }
  return prior;
}

/**
 * @param {import('mongodb').Collection} games
 * @param {"league" | "mmr"} bandType
 * @param {"after" | "before"} era
 */
async function aggregateRows(games, bandType, era) {
  return /** @type {Promise<any[]>} */ (
    games.aggregate(buildRecomputePipeline(bandType, era), { allowDiskUse: true }).toArray()
  );
}

/**
 * @param {import('mongodb').Collection} coll
 * @param {Record<string, any>[]} docs
 */
async function writeRows(coll, docs) {
  if (docs.length === 0) return;
  await coll.bulkWrite(
    docs.map((doc) => ({
      replaceOne: {
        filter: { era: doc.era, bandType: doc.bandType, band: doc.band, matchup: doc.matchup },
        replacement: doc,
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

/**
 * @param {any[]} rows
 * @param {"league" | "mmr"} bandType
 * @param {"after" | "before"} era
 * @param {Date} updatedAt
 * @param {Map<string, { openers: StoredOpener[], updatedAt: Date | null }>} prior
 */
function shapeRows(rows, bandType, era, updatedAt, prior) {
  return rows.map((row) => shapeBandRow(row, bandType, era, updatedAt, prior));
}

// ---------------- pipeline ----------------

/**
 * The recompute aggregation:
 *   1. keep 1v1 rows that carry the requested numeric opponent band
 *      source (league or MMR), string races, and a non-empty ``myBuild``
 *      that isn't the "Game Too Short" catch-all;
 *   2. derive the matchup letters and keep only P/T/Z on both sides;
 *   3. $group per (band, matchup, opener) for wins/losses/games;
 *   4. $group per (band, matchup) collecting the opener buckets and
 *      the band total.
 *
 * @param {"league" | "mmr"} bandType
 * @param {"after" | "before"} era
 * @returns {Array<Record<string, any>>}
 */
function buildRecomputePipeline(bandType = BAND_TYPE_LEAGUE, era = PATCH_ERA_AFTER) {
  return [
    { $match: buildGamesMatch(bandType, era) },
    {
      $addFields: {
        _band: buildBandExpression(bandType),
        _my: { $toUpper: { $substrCP: ["$myRace", 0, 1] } },
        _opp: { $toUpper: { $substrCP: ["$opponent.race", 0, 1] } },
      },
    },
    {
      $match: {
        _my: { $in: [...RACE_LETTERS] },
        _opp: { $in: [...RACE_LETTERS] },
      },
    },
    {
      $group: {
        _id: {
          band: "$_band",
          matchup: { $concat: ["$_my", "v", "$_opp"] },
          build: "$myBuild",
        },
        games: { $sum: 1 },
        wins: { $sum: { $cond: [{ $eq: ["$result", "Victory"] }, 1, 0] } },
        losses: { $sum: { $cond: [{ $eq: ["$result", "Defeat"] }, 1, 0] } },
      },
    },
    {
      $group: {
        _id: { band: "$_id.band", matchup: "$_id.matchup" },
        n: { $sum: "$games" },
        openers: {
          $push: {
            build: "$_id.build",
            games: "$games",
            wins: "$wins",
            losses: "$losses",
          },
        },
      },
    },
  ];
}

/** @param {"league" | "mmr"} bandType @param {"after" | "before"} era */
function buildGamesMatch(bandType, era) {
  const bandMatch = bandType === BAND_TYPE_MMR
    ? { "opponent.mmr": { $type: "number", $gte: MMR_FLOOR, $lt: MMR_CEILING } }
    : { "opponent.leagueId": { $type: "number" } };
  return {
    // Intentionally no userId predicate: Ladder Meta is computed from the
    // shared games collection across every account. User-scoped analytics
    // add userId in their service layer; this public aggregate must not.
    ...bandMatch,
    isResumedFromReplay: { $ne: true },
    myRace: { $type: "string" },
    "opponent.race": { $type: "string" },
    myBuild: { $type: "string", $ne: "", $not: /Game Too Short$/ },
    $and: [
      buildEraMatch(era),
      { $or: [{ playerCount: { $exists: false } }, { playerCount: 2 }] },
    ],
  };
}

/**
 * Prefer replay-authored version metadata over wall-clock time. ``gameBuild``
 * is monotonic and therefore authoritative. ``gameVersion`` covers partially
 * upgraded producers, while ``date`` keeps the historical corpus queryable.
 * The branches are mutually exclusive so a row cannot land in both eras.
 *
 * @param {"after" | "before"} era
 * @returns {Record<string, any>}
 */
function buildEraMatch(era) {
  const missingBuild = { gameBuild: { $not: { $type: "number" } } };
  const missingVersion = { gameVersion: { $not: { $type: "string" } } };
  const versionBuild = {
    $convert: {
      input: { $arrayElemAt: [{ $split: ["$gameVersion", "."] }, -1] },
      to: "int",
      onError: -1,
      onNull: -1,
    },
  };
  if (era === PATCH_ERA_BEFORE) {
    return {
      $or: [
        { gameBuild: { $type: "number", $lt: PATCH_5_0_16_BUILD } },
        {
          $and: [
            missingBuild,
            { gameVersion: { $type: "string" } },
            { $expr: { $lt: [versionBuild, PATCH_5_0_16_BUILD] } },
          ],
        },
        {
          $and: [
            missingBuild,
            missingVersion,
            { date: { $lt: PATCH_5_0_16_RELEASE } },
          ],
        },
      ],
    };
  }
  return {
    $or: [
      { gameBuild: { $type: "number", $gte: PATCH_5_0_16_BUILD } },
      {
        $and: [
          missingBuild,
          { gameVersion: { $type: "string" } },
          { $expr: { $gte: [versionBuild, PATCH_5_0_16_BUILD] } },
        ],
      },
      {
        $and: [
          missingBuild,
          missingVersion,
          { date: { $gte: PATCH_5_0_16_RELEASE } },
        ],
      },
    ],
  };
}

/** @param {"league" | "mmr"} bandType */
function buildBandExpression(bandType) {
  if (bandType === BAND_TYPE_LEAGUE) return "$opponent.leagueId";
  const bucket = {
    $multiply: [
      { $floor: { $divide: ["$opponent.mmr", LADDER_META_BUCKET_WIDTH] } },
      LADDER_META_BUCKET_WIDTH,
    ],
  };
  return {
    $switch: {
      branches: [
        { case: { $lt: [bucket, LADDER_META_LOW_CAP] }, then: MMR_FLOOR },
        { case: { $gte: [bucket, LADDER_META_HIGH_CAP] }, then: LADDER_META_HIGH_CAP },
      ],
      default: bucket,
    },
  };
}

/**
 * Shape one rolled-up $group row into the stored band document.
 * Aggregates only — no per-user field exists at this point in the
 * pipeline, so nothing user-identifying can leak into the output
 * collection. Openers below the per-opener floor are dropped; the
 * survivors are ranked by games (then winrate, then name) and capped at
 * TOP_N. The prior run's openers are attached as ``prevOpeners``.
 *
 * @param {any} row raw $group output
 * @param {"league" | "mmr"} bandType axis discriminator
 * @param {"after" | "before"} era patch-era discriminator
 * @param {Date} updatedAt shared recompute stamp
 * @param {Map<string, { openers: StoredOpener[], updatedAt: Date | null }>} priorByKey
 * @returns {Record<string, any>}
 */
function shapeBandRow(row, bandType, era, updatedAt, priorByKey) {
  const band = num(row._id.band);
  const matchup = String(row._id.matchup);
  const n = num(row.n);

  /** @type {any[]} */
  const rawOpeners = Array.isArray(row.openers) ? row.openers : [];
  const openers = rawOpeners
    .filter((o) => typeof o.games === "number" && o.games >= OPENER_MIN_SAMPLE)
    .map((o) => shapeStoredOpener(o, n))
    .sort(compareOpeners)
    .slice(0, TOP_N);

  const prior = priorByKey.get(bandKey(era, bandType, band, matchup));
  const bandLabel = labelForBand(bandType, band);
  const doc = {
    era,
    bandType,
    band,
    bandLabel,
    matchup,
    n,
    openers,
    prevOpeners: prior ? prior.openers : null,
    prevUpdatedAt: prior ? prior.updatedAt : null,
    updatedAt,
    [VERSION_KEY]: SCHEMA_VERSION,
  };
  if (bandType === BAND_TYPE_LEAGUE) {
    return { ...doc, leagueBand: band, league: bandLabel };
  }
  return doc;
}

/**
 * @param {any} o one opener bucket from the pipeline
 * @param {number} bandN total games in the band (for frequency)
 * @returns {StoredOpener}
 */
function shapeStoredOpener(o, bandN) {
  const games = num(o.games);
  const wins = num(o.wins);
  const losses = num(o.losses);
  const decided = wins + losses;
  return {
    build: String(o.build),
    games,
    wins,
    losses,
    // Winrate over DECIDED games (ties, though effectively nonexistent
    // on ladder, don't count against a build).
    winRate: decided > 0 ? round4(wins / decided) : 0,
    // Prevalence: this opener's share of the band's games.
    frequency: bandN > 0 ? round4(games / bandN) : 0,
  };
}

/**
 * Fold the stored ``prevOpeners`` snapshot into per-opener deltas and
 * return the public row shape (never exposing the raw prev array or the
 * schema-version key).
 *
 * @param {any} row stored ``ladder_meta`` document (``_id`` projected out)
 * @param {{bandType: "league" | "mmr", band: number}} requested
 * @returns {Record<string, any>}
 */
function shapeServedRow(row, requested) {
  const bandType = row.bandType === BAND_TYPE_MMR
    ? BAND_TYPE_MMR
    : requested.bandType;
  const band = Number.isFinite(row.band) ? row.band : requested.band;
  /** @type {Map<string, StoredOpener>} */
  const prevByBuild = new Map();
  if (Array.isArray(row.prevOpeners)) {
    for (const p of row.prevOpeners) {
      if (p && typeof p.build === "string") prevByBuild.set(p.build, p);
    }
  }
  /** @type {any[]} */
  const storedOpeners = Array.isArray(row.openers) ? row.openers : [];
  const openers = storedOpeners.map((o) => {
    const prev = prevByBuild.get(o.build);
    return {
      build: o.build,
      games: num(o.games),
      wins: num(o.wins),
      losses: num(o.losses),
      winRate: num(o.winRate),
      frequency: num(o.frequency),
      winRateDelta: prev ? round4(num(o.winRate) - num(prev.winRate)) : null,
      freqDelta: prev ? round4(num(o.frequency) - num(prev.frequency)) : null,
      isNew: !prev,
    };
  });
  const bandLabel = typeof row.bandLabel === "string"
    ? row.bandLabel
    : labelForBand(bandType, band);
  const served = {
    era: normalizePatchEra(row.era) || PATCH_ERA_AFTER,
    bandType,
    band,
    bandLabel,
    matchup: String(row.matchup),
    n: num(row.n),
    openers,
    updatedAt: row.updatedAt,
    prevUpdatedAt: row.prevUpdatedAt || null,
  };
  if (bandType === BAND_TYPE_LEAGUE) {
    return {
      ...served,
      leagueBand: band,
      league: typeof row.league === "string" ? row.league : bandLabel,
    };
  }
  return served;
}

/**
 * Rank order for openers: most-played first, then higher winrate, then
 * name — a total order so a re-run on unchanged data is stable.
 *
 * @param {StoredOpener} a
 * @param {StoredOpener} b
 */
function compareOpeners(a, b) {
  if (b.games !== a.games) return b.games - a.games;
  if (b.winRate !== a.winRate) return b.winRate - a.winRate;
  return a.build < b.build ? -1 : a.build > b.build ? 1 : 0;
}

/** @param {Record<string, any>} args */
function normalizeBandRequest(args) {
  const legacy = args.bandType === undefined && args.band === undefined;
  const bandType = legacy ? BAND_TYPE_LEAGUE : args.bandType;
  const band = legacy ? args.leagueId : args.band;
  if (bandType !== BAND_TYPE_LEAGUE && bandType !== BAND_TYPE_MMR) return null;
  if (typeof band !== "number" || !Number.isInteger(band)) return null;
  if (bandType === BAND_TYPE_MMR && !isLadderMetaMmrBand(band)) return null;
  return { bandType, band };
}

/** @param {"league" | "mmr"} bandType @param {number} band */
function labelForBand(bandType, band) {
  if (bandType === BAND_TYPE_MMR) {
    return ladderMetaBracketLabel(band) || `MMR ${band}`;
  }
  return leagueLabel(band);
}

/** @param {"after" | "before"} era @param {"league" | "mmr"} bandType @param {number} band @param {string} matchup */
function bandKey(era, bandType, band, matchup) {
  return `${era}::${bandType}::${band}::${matchup}`;
}

/**
 * Missing era remains backwards compatible and defaults to the live patch.
 * @param {unknown} raw
 * @returns {"after" | "before" | null}
 */
function normalizePatchEra(raw) {
  if (raw === undefined) return PATCH_ERA_AFTER;
  return raw === PATCH_ERA_AFTER || raw === PATCH_ERA_BEFORE ? raw : null;
}

/** @param {number} leagueBand */
function leagueLabel(leagueBand) {
  const name = /** @type {Record<number, string>} */ (LEAGUE_NAMES)[leagueBand];
  return name || `League ${leagueBand}`;
}

/**
 * Canonicalize a matchup string: "pvz" / "P v Z" / "PvZ" -> "PvZ".
 * Returns null for anything that isn't two P/T/Z letters around a v.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeMatchup(raw) {
  if (typeof raw !== "string") return null;
  const m = /^([ptz])\s*v\s*([ptz])$/i.exec(raw.trim());
  if (!m) return null;
  return `${m[1].toUpperCase()}v${m[2].toUpperCase()}`;
}

/** @param {unknown} v @returns {number} */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Round to 4 decimals (winrate/frequency are fractions in 0..1).
 * @param {number} v @returns {number}
 */
function round4(v) {
  return Math.round(v * 10000) / 10000;
}

module.exports = {
  LadderMetaService,
  COLLECTION_NAME,
  MIN_SAMPLE,
  OPENER_MIN_SAMPLE,
  TOP_N,
  SCHEMA_VERSION,
  BAND_TYPE_LEAGUE,
  BAND_TYPE_MMR,
  BAND_INDEX_KEY,
  PATCH_ERA_AFTER,
  PATCH_ERA_BEFORE,
  PATCH_5_0_16_BUILD,
  PATCH_5_0_16_RELEASE,
  buildRecomputePipeline,
  migrateBandIndex,
  normalizeMatchup,
};
