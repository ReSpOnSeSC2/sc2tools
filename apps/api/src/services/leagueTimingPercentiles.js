"use strict";

const { VERSION_KEY } = require("../db/schemaVersioning");
const { GUIDE_MILESTONES } = require("../config/guideMilestones");
const { GUIDE_CELL_MIN_USERS, GUIDE_USER_CELL_CAP } = require("../config/guides");
const { PATCH_ERAS, PATCH_ERA_AFTER, PATCH_ERA_RULE } = require("../util/patchEra");
const { MIN_SAMPLE, DECILE_PS } = require("./leaguePercentiles");

/**
 * League timing percentiles: per (era, opponent league, matchup) decile
 * tables of four build timings — natural, third, first upgrade and key tech —
 * so the Macro tab's Targets card can say "your natural is 12 s later than
 * the Master PvZ median".
 *
 * Data source — ``guide_samples`` ONLY (services/guideSamples.js): the
 * compact, pseudonymous per-game milestone times distilled at ingest. The
 * nightly recompute never reads ``game_details`` or the slim ``games`` rows.
 * Samples carry no userId; ``userHash`` is used inside the pipeline only for
 * the per-user cap and the distinct-player floor and never leaves it.
 *
 * Banding — ``leagueBand`` is the OPPONENT's league (0 Bronze … 6
 * Grandmaster), the same proxy as league_percentiles (SC2 matchmaking pairs
 * near-equal ratings). Era (12-worker "after" vs 8-worker "before") is part
 * of the key: an 8-worker natural is a different number.
 *
 * Timings — recorded build-log seconds (config/guideMilestones.js house
 * rule: no balance-duration subtraction). Natural/third are the 2nd/3rd town
 * hall started; first upgrade is the earliest finished upgrade of the
 * race's tracked set; key tech is the first tech step (Protoss: the first
 * of Twilight Council, Stargate, Robotics Facility; Terran: Factory; Zerg:
 * Lair finished).
 *
 * Privacy floor — the same k = 50 as league_percentiles (MIN_SAMPLE) plus
 * the guides' distinct-player floor (GUIDE_CELL_MIN_USERS), applied to the
 * band and to every timing; one player contributes at most
 * GUIDE_USER_CELL_CAP samples per band. ``lookup`` serves nothing below the
 * floor, and a band row never stores a per-user field.
 */

const COLLECTION_NAME = "league_timing_percentiles";
const SCHEMA_VERSION = 1;
/** @typedef {"natural" | "third" | "firstUpgrade" | "keyTech"} TimingKey */
/** @type {ReadonlyArray<TimingKey>} */
const TIMING_KEYS = Object.freeze(["natural", "third", "firstUpgrade", "keyTech"]);
/** Personal sample: the player's most recent samples in the matchup and era. */
const PERSONAL_LIMIT = 20;
/** A personal median needs at least this many of the player's own samples. */
const PERSONAL_MIN_SAMPLE = 3;
const RACE_LETTERS = Object.freeze(["P", "T", "Z"]);
const MATCHUPS = Object.freeze(RACE_LETTERS.flatMap((me) => RACE_LETTERS.map((them) => `${me}v${them}`)));

/** Milestone keys behind each timing, per race (earliest wins). */
const TIMING_MILESTONES = Object.freeze({
  P: Object.freeze({
    natural: ["Nexus#2"], third: ["Nexus#3"],
    firstUpgrade: ["WarpGateResearch", "BlinkTech", "Charge", "AdeptPiercingAttack"],
    keyTech: ["TwilightCouncil", "Stargate", "RoboticsFacility"],
  }),
  T: Object.freeze({
    natural: ["CommandCenter#2"], third: ["CommandCenter#3"],
    firstUpgrade: ["Stimpack", "ShieldWall", "PunisherGrenades", "TerranInfantryWeaponsLevel1"],
    keyTech: ["Factory"],
  }),
  Z: Object.freeze({
    natural: ["Hatchery#2"], third: ["Hatchery#3"],
    firstUpgrade: ["ZerglingMovementSpeed", "GlialReconstitution"],
    keyTech: ["Lair"],
  }),
});

// Every referenced key must be a stored milestone key; a rename there would
// otherwise silently empty a timing.
for (const [race, timings] of Object.entries(TIMING_MILESTONES)) {
  const known = new Set(GUIDE_MILESTONES[/** @type {"P"|"T"|"Z"} */ (race)].map((m) => m.key));
  for (const keys of Object.values(timings)) {
    for (const key of keys) {
      if (!known.has(key)) throw new Error(`leagueTimingPercentiles: unknown milestone ${race}:${key}`);
    }
  }
}

const LEAGUE_NAMES = Object.freeze(["Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master", "Grandmaster"]);

/** @param {number} leagueId */
function leagueLabel(leagueId) {
  return LEAGUE_NAMES[leagueId] || `League ${leagueId}`;
}

/**
 * Aggregation expression: one timing's seconds for the sample's own race,
 * null when the game never reached it.
 *
 * @param {"natural"|"third"|"firstUpgrade"|"keyTech"} timing
 */
function timingExpression(timing) {
  return {
    $switch: {
      branches: RACE_LETTERS.map((race) => ({
        case: { $eq: ["$_race", race] },
        then: { $min: TIMING_MILESTONES[/** @type {"P"|"T"|"Z"} */ (race)][timing].map((key) => `$milestones.${key}`) },
      })),
      default: null,
    },
  };
}

/**
 * The one recompute aggregation: stamped samples with a league band →
 * per-user cap per band → per-band n / distinct players / decile vectors.
 *
 * @returns {Record<string, any>[]}
 */
function buildRecomputePipeline() {
  /** @type {Record<string, any>} */
  const project = {
    _id: 0, userHash: 1, era: 1, leagueBand: 1, matchup: 1,
    _race: { $substrCP: ["$matchup", 0, 1] },
    // The per-player cap keeps the most recent games: the played day, or the
    // capture time for rows from before ``playedOn`` existed, with the game
    // hash as a stable tie-break ($documentNumber takes one sort key).
    _recency: {
      $concat: [
        { $dateToString: { date: { $ifNull: ["$playedOn", "$createdAt"] } } },
        "|",
        { $ifNull: ["$gameHash", ""] },
      ],
    },
    milestones: 1,
  };
  /** @type {Record<string, any>} */
  const values = {};
  for (const timing of TIMING_KEYS) values[timing] = timingExpression(timing);
  /** @type {Record<string, any>} */
  const group = {
    _id: { era: "$era", leagueId: "$leagueBand", matchup: "$matchup" },
    n: { $sum: 1 },
    users: { $addToSet: "$userHash" },
  };
  for (const timing of TIMING_KEYS) {
    const path = `$${timing}`;
    const valid = { $and: [{ $isNumber: path }, { $gte: [path, 0] }] };
    group[`${timing}_n`] = { $sum: { $cond: [valid, 1, 0] } };
    group[`${timing}_users`] = { $addToSet: { $cond: [valid, "$userHash", "$$REMOVE"] } };
    group[`${timing}_deciles`] = { $percentile: { input: path, p: [...DECILE_PS], method: "approximate" } };
  }
  return [
    {
      $match: {
        eraRule: PATCH_ERA_RULE,
        era: { $in: [...PATCH_ERAS] },
        leagueBand: { $type: "number", $gte: 0, $lte: 6 },
        matchup: { $in: [...MATCHUPS] },
        userHash: { $type: "string" },
      },
    },
    { $project: project },
    {
      $setWindowFields: {
        partitionBy: { user: "$userHash", era: "$era", league: "$leagueBand", matchup: "$matchup" },
        sortBy: { _recency: -1 },
        output: { capRank: { $documentNumber: {} } },
      },
    },
    { $match: { capRank: { $lte: GUIDE_USER_CELL_CAP } } },
    { $addFields: values },
    { $group: group },
    {
      $project: {
        _id: 1, n: 1, users: { $size: "$users" },
        ...Object.fromEntries(TIMING_KEYS.flatMap((timing) => [
          [`${timing}_n`, 1],
          [`${timing}_users`, { $size: `$${timing}_users` }],
          [`${timing}_deciles`, 1],
        ])),
      },
    },
  ];
}

/**
 * Round and monotone-fix a raw $percentile vector; null unless complete.
 *
 * @param {unknown} raw
 * @returns {number[] | null}
 */
function sanitizeDeciles(raw) {
  if (!Array.isArray(raw) || raw.length !== DECILE_PS.length) return null;
  /** @type {number[]} */
  const out = [];
  for (const value of raw) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    out.push(Math.round(value));
  }
  for (let i = 1; i < out.length; i += 1) if (out[i] < out[i - 1]) out[i] = out[i - 1];
  return out;
}

/**
 * The served shape of one timing: deciles only above both floors.
 *
 * @param {number} n @param {number} users @param {unknown} deciles
 */
function servedTiming(n, users, deciles) {
  const ok = n >= MIN_SAMPLE && users >= GUIDE_CELL_MIN_USERS;
  return { n, deciles: ok ? sanitizeDeciles(deciles) : null };
}

/** @param {any} row @param {Date} updatedAt */
function shapeBandRow(row, updatedAt) {
  const leagueId = Number(row._id.leagueId);
  /** @type {Record<string, {n: number, users: number, deciles: number[] | null}>} */
  const timings = {};
  for (const timing of TIMING_KEYS) {
    const n = Number(row[`${timing}_n`]) || 0;
    timings[timing] = { n, users: Number(row[`${timing}_users`]) || 0, deciles: n > 0 ? sanitizeDeciles(row[`${timing}_deciles`]) : null };
  }
  return {
    era: String(row._id.era),
    leagueId,
    league: leagueLabel(leagueId),
    matchup: String(row._id.matchup),
    n: Number(row.n) || 0,
    users: Number(row.users) || 0,
    timings,
    updatedAt,
    [VERSION_KEY]: SCHEMA_VERSION,
  };
}

/** @param {unknown} raw @returns {string | null} */
function normalizeMatchup(raw) {
  if (typeof raw !== "string") return null;
  const m = /^([ptz])\s*v\s*([ptz])$/i.exec(raw.trim());
  return m ? `${m[1].toUpperCase()}v${m[2].toUpperCase()}` : null;
}

/**
 * One timing's seconds in one stored sample, for the sample's own race.
 *
 * @param {Record<string, any>} sample
 * @param {"natural"|"third"|"firstUpgrade"|"keyTech"} timing
 * @returns {number | null}
 */
function sampleTiming(sample, timing) {
  const race = typeof sample.matchup === "string" ? sample.matchup[0] : "";
  const keys = /** @type {Record<string, Record<string, string[]>>} */ (TIMING_MILESTONES)[race]?.[timing];
  if (!keys) return null;
  let best = null;
  for (const key of keys) {
    const value = sample.milestones?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && (best === null || value < best)) best = value;
  }
  return best;
}

/** @param {number[]} values */
function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Personal medians use the same milestone definitions as the cohort. Only
 * include readable build logs from the selected patch era.
 * @param {string} matchup @param {string|null} era
 * @param {Record<string,number>[]} milestones
 */
function personalTimingSummary(matchup, era, milestones) {
  /** @type {Record<string, {n: number, median: number | null}>} */
  const timings = {};
  for (const timing of TIMING_KEYS) {
    const values = milestones.map((row) => sampleTiming({ matchup, milestones: row }, timing)).filter((value) => value !== null);
    timings[timing] = {
      n: values.length,
      median: values.length >= PERSONAL_MIN_SAMPLE ? Math.round(median(/** @type {number[]} */ (values))) : null,
    };
  }
  return { era, n: milestones.length, limit: PERSONAL_LIMIT, timings };
}

class LeagueTimingPercentilesService {
  /**
   * @param {{ guideSamples: import('mongodb').Collection, db: import('mongodb').Db }} db
   * @param {{ logger?: { info: (obj: Record<string, unknown>, msg: string) => void } | null, now?: () => number }} [opts]
   */
  constructor(db, opts = {}) {
    this.samples = db.guideSamples;
    this.coll = db.db.collection(COLLECTION_NAME);
    this.logger = opts.logger || null;
    this.now = opts.now || (() => Date.now());
  }

  /**
   * Full nightly rebuild, idempotent: bands the corpus no longer produces
   * are dropped.
   *
   * @returns {Promise<{ bands: number, updatedAt: Date }>}
   */
  async recompute() {
    const updatedAt = new Date(this.now());
    await this.coll.createIndex({ era: 1, leagueId: 1, matchup: 1 }, { unique: true });
    const rows = await this.samples.aggregate(buildRecomputePipeline(), { allowDiskUse: true }).toArray();
    const docs = rows.map((row) => shapeBandRow(row, updatedAt));
    if (docs.length > 0) {
      await this.coll.bulkWrite(docs.map((doc) => ({
        replaceOne: { filter: { era: doc.era, leagueId: doc.leagueId, matchup: doc.matchup }, replacement: doc, upsert: true },
      })), { ordered: false });
    }
    await this.coll.deleteMany({ updatedAt: { $lt: updatedAt } });
    this.logger?.info({ bands: docs.length, collection: COLLECTION_NAME }, "league_timing_percentiles_recomputed");
    return { bands: docs.length, updatedAt };
  }

  /**
   * One served band, or null when unknown or below the floor (the caller
   * cannot tell which, by design). Timings below the floor keep their count
   * but no deciles.
   *
   * @param {{ leagueId: number, matchup: string, era?: string }} args
   */
  async lookup({ leagueId, matchup, era = PATCH_ERA_AFTER }) {
    const mu = normalizeMatchup(matchup);
    if (!Number.isInteger(leagueId) || leagueId < 0 || leagueId > 6 || !mu || !PATCH_ERAS.includes(/** @type {any} */ (era))) return null;
    const row = /** @type {any} */ (await this.coll.findOne({ era, leagueId, matchup: mu }, { projection: { _id: 0 } }));
    if (!row || !(row.n >= MIN_SAMPLE) || !(row.users >= GUIDE_CELL_MIN_USERS)) return null;
    /** @type {Record<string, {n: number, deciles: number[] | null}>} */
    const timings = {};
    for (const timing of TIMING_KEYS) {
      const item = row.timings?.[timing] || {};
      timings[timing] = servedTiming(Number(item.n) || 0, Number(item.users) || 0, item.deciles);
    }
    return { era: row.era, leagueId: row.leagueId, league: row.league, matchup: row.matchup, n: row.n,
      timings, updatedAt: row.updatedAt };
  }

}

module.exports = {
  LeagueTimingPercentilesService,
  COLLECTION_NAME,
  TIMING_KEYS,
  TIMING_MILESTONES,
  PERSONAL_LIMIT,
  PERSONAL_MIN_SAMPLE,
  buildRecomputePipeline,
  sampleTiming,
  personalTimingSummary,
};
