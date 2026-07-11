"use strict";

const { VERSION_KEY } = require("../db/schemaVersioning");

/**
 * Ladder Meta Radar — the effectiveness-weighted opener meta report.
 *
 * Where the Spawning Tool shows pro PREVALENCE and SC2Pulse shows race
 * winrates, this shows — from the whole SC2 Tools user corpus — which
 * OPENERS actually WIN, sliced by (league band, matchup), with
 * week-over-week movement. It is the public, SEO-facing counterpart to
 * services/leaguePercentiles.js and is built the same way: one nightly
 * aggregation over the SLIM ``games`` rows into a small collection, a
 * k-anonymity floor before anything is served, and no per-user field in
 * the output.
 *
 * Data source — SLIM ``games`` rows only. The three fields we group on
 * (``opponent.leagueId``, ``myRace`` + ``opponent.race``, ``myBuild``)
 * plus ``result`` all live on the slim row (see validation/gameRecord.js
 * and services/games.js); the heavy ``game_details`` blob is never
 * touched.
 *
 * League banding — slim games rows carry NO "my league" field; the only
 * league signal is ``opponent.leagueId`` (SC2 league enum, stamped by
 * the agent for ladder games). We band by it exactly like
 * leaguePercentiles: SC2 matchmaking pairs near-equal ratings, so the
 * opponent's league is a faithful proxy for the bracket the game was
 * played in. ``leagueBand`` is that numeric id (identity banding — one
 * band per league) and ``league`` is its display label.
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
const SCHEMA_VERSION = 1;

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
  }

  /**
   * Full rebuild of the ladder-meta tables. One aggregation over the
   * whole ``games`` corpus grouped by (leagueBand, matchup, opener),
   * rolled up per (leagueBand, matchup), then upserted into
   * ``ladder_meta`` keyed on (leagueBand, matchup). The prior run's
   * openers are carried forward as ``prevOpeners`` so lookup can compute
   * week-over-week deltas. Bands that no longer exist in the corpus are
   * removed, so repeated runs are idempotent.
   *
   * @returns {Promise<{ bands: number, updatedAt: Date }>}
   */
  async recompute() {
    const updatedAt = new Date(this.now());
    // Idempotent — Mongo skips indexes that already exist. Keyed the
    // same way ``lookup`` queries.
    await this.coll.createIndex(
      { leagueBand: 1, matchup: 1 },
      { unique: true },
    );

    // Snapshot the current openers BEFORE we overwrite them so each new
    // band doc can carry its predecessor forward for WoW deltas.
    const priorDocs = /** @type {any[]} */ (
      await this.coll
        .find({}, { projection: { _id: 0, leagueBand: 1, matchup: 1, openers: 1, updatedAt: 1 } })
        .toArray()
    );
    /** @type {Map<string, { openers: StoredOpener[], updatedAt: Date | null }>} */
    const priorByKey = new Map();
    for (const doc of priorDocs) {
      priorByKey.set(bandKey(doc.leagueBand, doc.matchup), {
        openers: Array.isArray(doc.openers) ? doc.openers : [],
        updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt : null,
      });
    }

    const rows = /** @type {any[]} */ (
      await this.games
        .aggregate(buildRecomputePipeline(), { allowDiskUse: true })
        .toArray()
    );
    const docs = rows.map((row) => shapeBandRow(row, updatedAt, priorByKey));

    if (docs.length > 0) {
      await this.coll.bulkWrite(
        docs.map((doc) => ({
          replaceOne: {
            filter: { leagueBand: doc.leagueBand, matchup: doc.matchup },
            replacement: doc,
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
    // Every fresh row carries the same ``updatedAt`` stamp, so anything
    // older is a band the corpus no longer produces — drop it.
    await this.coll.deleteMany({ updatedAt: { $lt: updatedAt } });

    if (this.logger) {
      this.logger.info(
        { bands: docs.length, collection: COLLECTION_NAME },
        "ladder_meta_recomputed",
      );
    }
    return { bands: docs.length, updatedAt };
  }

  /**
   * Fetch one meta row with week-over-week deltas folded in. Returns
   * ``null`` when the (band, matchup) is unknown OR its total sample is
   * below the ``MIN_SAMPLE`` k-anonymity floor — the caller can't tell
   * the difference, by design.
   *
   * @param {{ leagueId: number, matchup: string }} args
   *        ``matchup`` is case-insensitive ("pvz" and "PvZ" both work).
   * @returns {Promise<MetaRow | null>}
   */
  async lookup({ leagueId, matchup }) {
    if (typeof leagueId !== "number" || !Number.isFinite(leagueId)) {
      return null;
    }
    const mu = normalizeMatchup(matchup);
    if (!mu) return null;
    const row = /** @type {any} */ (
      await this.coll.findOne(
        { leagueBand: leagueId, matchup: mu },
        { projection: { _id: 0 } },
      )
    );
    if (!row || typeof row.n !== "number" || row.n < MIN_SAMPLE) return null;
    return shapeServedRow(row);
  }
}

// ---------------- pipeline ----------------

/**
 * The recompute aggregation:
 *   1. keep 1v1 rows that carry a numeric ``opponent.leagueId``, string
 *      races, and a non-empty ``myBuild`` that isn't the "Game Too
 *      Short" catch-all;
 *   2. derive the matchup letters and keep only P/T/Z on both sides;
 *   3. $group per (leagueId, matchup, opener) for wins/losses/games;
 *   4. $group per (leagueId, matchup) collecting the opener buckets and
 *      the band total.
 *
 * @returns {Array<Record<string, any>>}
 */
function buildRecomputePipeline() {
  return [
    {
      $match: {
        "opponent.leagueId": { $type: "number" },
        myRace: { $type: "string" },
        "opponent.race": { $type: "string" },
        // Real openers only: a present, non-empty label that isn't the
        // "<X>v<Y> - Game Too Short" bucket.
        myBuild: { $type: "string", $ne: "", $not: /Game Too Short$/ },
        // 1v1 only. ``playerCount`` is optional (older agents), so a
        // missing count is trusted — the opponent.leagueId requirement
        // already filters most non-ladder rows.
        $or: [{ playerCount: { $exists: false } }, { playerCount: 2 }],
      },
    },
    {
      $addFields: {
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
          leagueId: "$opponent.leagueId",
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
        _id: { leagueId: "$_id.leagueId", matchup: "$_id.matchup" },
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

/**
 * Shape one rolled-up $group row into the stored band document.
 * Aggregates only — no per-user field exists at this point in the
 * pipeline, so nothing user-identifying can leak into the output
 * collection. Openers below the per-opener floor are dropped; the
 * survivors are ranked by games (then winrate, then name) and capped at
 * TOP_N. The prior run's openers are attached as ``prevOpeners``.
 *
 * @param {any} row raw $group output
 * @param {Date} updatedAt shared recompute stamp
 * @param {Map<string, { openers: StoredOpener[], updatedAt: Date | null }>} priorByKey
 * @returns {Record<string, any>}
 */
function shapeBandRow(row, updatedAt, priorByKey) {
  const leagueBand = /** @type {number} */ (row._id.leagueId);
  const matchup = String(row._id.matchup);
  const n = typeof row.n === "number" ? row.n : 0;

  /** @type {any[]} */
  const rawOpeners = Array.isArray(row.openers) ? row.openers : [];
  const openers = rawOpeners
    .filter((o) => typeof o.games === "number" && o.games >= OPENER_MIN_SAMPLE)
    .map((o) => shapeStoredOpener(o, n))
    .sort(compareOpeners)
    .slice(0, TOP_N);

  const prior = priorByKey.get(bandKey(leagueBand, matchup));
  return {
    leagueBand,
    league: leagueLabel(leagueBand),
    matchup,
    n,
    openers,
    prevOpeners: prior ? prior.openers : null,
    prevUpdatedAt: prior ? prior.updatedAt : null,
    updatedAt,
    [VERSION_KEY]: SCHEMA_VERSION,
  };
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
 * @returns {MetaRow}
 */
function shapeServedRow(row) {
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
  return {
    leagueBand: num(row.leagueBand),
    league: typeof row.league === "string" ? row.league : leagueLabel(num(row.leagueBand)),
    matchup: String(row.matchup),
    n: num(row.n),
    openers,
    updatedAt: row.updatedAt,
    prevUpdatedAt: row.prevUpdatedAt || null,
  };
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

/** @param {number} leagueBand @param {string} matchup */
function bandKey(leagueBand, matchup) {
  return `${leagueBand}::${matchup}`;
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
  normalizeMatchup,
};
