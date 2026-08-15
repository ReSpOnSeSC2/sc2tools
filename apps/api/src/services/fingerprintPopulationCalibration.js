"use strict";

const { VERSION_KEY } = require("../db/schemaVersioning");
const {
  WINDOW_GAMES: PLAYER_WINDOW_GAMES,
  matchupBalanceAxis,
  matchupEdgeAxis,
  paceAxis,
  repertoireAxis,
} = require("./skillFingerprint");

/**
 * Population calibration for the replay-derived player fingerprint.
 *
 * The unit of observation is one player's latest qualifying 1v1 window in a
 * matchup, not one replay. Recompute briefly holds those player windows in
 * memory so it can call the exact same axis functions as the live fingerprint,
 * then persists only matchup-level aggregates. No user identifier is written
 * to the calibration collection.
 *
 * Exact value histograms are intentional. A decile ladder cannot assign an
 * empirical midrank to a tied value, while fingerprint measurements contain
 * many meaningful ties (one effective build, a 50/50 matchup, and so on).
 */

const COLLECTION_NAME = "fingerprint_population_calibration";
const SCHEMA_VERSION = 1;
const MIN_POPULATION_SAMPLE = 50;
const RACE_LETTERS = Object.freeze(["P", "T", "Z"]);

const REFERENCE_METADATA = Object.freeze({
  version: SCHEMA_VERSION,
  population: "global",
  unit: "player_matchup_window",
  windowGames: PLAYER_WINDOW_GAMES,
  windowMode: "latest",
  filters: "non_resumed_1v1_ptz_matchups",
  window: Object.freeze({
    mode: "latest_qualifying_1v1",
    games: PLAYER_WINDOW_GAMES,
  }),
  histogram: "exact_values",
  percentile: "empirical_midrank_cdf",
  minPopulationSample: MIN_POPULATION_SAMPLE,
});

const PACE_RARITY_CATEGORIES = new Set([
  "timing_attacker",
  "mid_late_master",
  "late_game_master",
  "two_speed",
]);
const MATCHUP_CONTINUOUS_CATEGORIES = new Set([
  "matchup_edge",
  "matchup_hurdle",
]);
const MATCHUP_RARITY_CATEGORIES = new Set([
  "specialist",
  "universalist",
  "blind_spot",
]);

/** @typedef {{ value: number, count: number }} HistogramPoint */
/**
 * @typedef {{
 *   metric: string,
 *   n: number,
 *   valueN: number,
 *   histogram: Map<number, number>,
 *   categoryCounts: Map<string, number>,
 * }} AxisAccumulator
 */
/**
 * @typedef {{
 *   matchup: string,
 *   n: number,
 *   axes: {
 *     repertoire: AxisAccumulator,
 *     pace: AxisAccumulator,
 *     matchup_edge: AxisAccumulator,
 *   },
 * }} MatchupAccumulator
 */

class FingerprintPopulationCalibrationService {
  /**
   * @param {{ games: import('mongodb').Collection, db: import('mongodb').Db }} db
   * @param {{
   *   logger?: { info: (obj: Record<string, unknown>, msg: string) => void } | null,
   *   now?: () => number,
   *   collection?: import('mongodb').Collection,
   * }} [opts]
   */
  constructor(db, opts = {}) {
    if (!db || !db.games) {
      throw new Error(
        "FingerprintPopulationCalibrationService: games collection required",
      );
    }
    const collection =
      opts.collection ||
      (db.db && typeof db.db.collection === "function"
        ? db.db.collection(COLLECTION_NAME)
        : null);
    if (!collection) {
      throw new Error(
        "FingerprintPopulationCalibrationService: database handle required",
      );
    }
    this.games = db.games;
    this.coll = collection;
    this.logger = opts.logger || null;
    this.now = opts.now || (() => Date.now());
  }

  /**
   * Rebuild every global matchup table from player-level latest-50 windows.
   * Persisted documents contain only histograms, category counts, and reference
   * metadata. Repeated runs replace each matchup atomically and remove matchups
   * that disappeared from the source corpus.
   *
   * @returns {Promise<{
   *   matchups: number,
   *   playerMatchupWindows: number,
   *   updatedAt: Date,
   * }>}
   */
  async recompute() {
    const updatedAt = new Date(this.now());
    await this.coll.createIndex({ matchup: 1 }, { unique: true });

    const windows = await this.games
      .aggregate(buildPlayerWindowsPipeline(), { allowDiskUse: true })
      .toArray();
    const built = buildCalibrationRows(windows, updatedAt);

    if (built.docs.length > 0) {
      await this.coll.bulkWrite(
        built.docs.map((doc) => ({
          replaceOne: {
            filter: { matchup: doc.matchup },
            replacement: doc,
            upsert: true,
          },
        })),
        { ordered: false },
      );
      await this.coll.deleteMany({
        matchup: { $nin: built.docs.map((doc) => doc.matchup) },
      });
    } else {
      await this.coll.deleteMany({});
    }

    if (this.logger) {
      this.logger.info(
        {
          matchups: built.docs.length,
          playerMatchupWindows: built.playerMatchupWindows,
          collection: COLLECTION_NAME,
        },
        "fingerprint_population_calibration_recomputed",
      );
    }
    return {
      matchups: built.docs.length,
      playerMatchupWindows: built.playerMatchupWindows,
      updatedAt,
    };
  }

  /**
   * Return one population table only when its overall player-window sample is
   * large enough and its schema/reference version is current. Individual axes
   * can still be unavailable when fewer than 50 of those windows rated on that
   * axis; {@link scoreAxis} enforces that narrower floor.
   *
   * @param {{ matchup: string }} args
   * @returns {Promise<Record<string, any> | null>}
   */
  async lookup(args) {
    const matchup = typeof args === "string" ? args : args && args.matchup;
    const mu = normalizeMatchup(matchup);
    if (!mu) return null;
    const row = await this.coll.findOne(
      { matchup: mu },
      { projection: { _id: 0 } },
    );
    if (
      !row ||
      !Number.isInteger(row.n) ||
      row.n < MIN_POPULATION_SAMPLE ||
      row[VERSION_KEY] !== SCHEMA_VERSION ||
      !row.reference ||
      row.reference.version !== SCHEMA_VERSION
    ) {
      return null;
    }
    return row;
  }

  /**
   * Metadata-rich scorer used by the live fingerprint response.
   * @param {Record<string, any> | null} table
   * @param {string} axisKey
   * @param {Record<string, any>} result
   * @returns {ReturnType<typeof scoreAxisCalibration>}
   */
  scoreAxis(table, axisKey, result) {
    return scoreAxisCalibration(table, axisKey, result);
  }

  /**
   * Lookup and score one axis in one call. Missing or undersampled reference
   * data returns null; this service never substitutes marker distance.
   *
   * @param {{ matchup: string, axisKey: string, result: Record<string, any> }} args
   */
  async scoreForMatchup({ matchup, axisKey, result }) {
    const table = await this.lookup({ matchup });
    return scoreAxisCalibration(table, axisKey, result);
  }
}

/**
 * Select each player's latest qualifying 50 rows in each matchup, then group
 * the slim fields required by the existing fingerprint axis functions.
 * ``userId`` exists only in this transient aggregation result.
 *
 * @returns {Array<Record<string, any>>}
 */
function buildPlayerWindowsPipeline() {
  return [
    {
      $match: {
        userId: { $type: "string", $ne: "" },
        isResumedFromReplay: { $ne: true },
        myRace: { $type: "string" },
        "opponent.race": { $type: "string" },
        $or: [
          { matchFormat: "1v1" },
          { matchFormat: { $exists: false }, playerCount: 2 },
        ],
      },
    },
    {
      $addFields: {
        _fingerprintMyRace: {
          $toUpper: { $substrCP: ["$myRace", 0, 1] },
        },
        _fingerprintOpponentRace: {
          $toUpper: { $substrCP: ["$opponent.race", 0, 1] },
        },
      },
    },
    {
      $match: {
        _fingerprintMyRace: { $in: [...RACE_LETTERS] },
        _fingerprintOpponentRace: { $in: [...RACE_LETTERS] },
      },
    },
    {
      $addFields: {
        _fingerprintMatchup: {
          $concat: [
            "$_fingerprintMyRace",
            "v",
            "$_fingerprintOpponentRace",
          ],
        },
      },
    },
    {
      $group: {
        _id: {
          userId: "$userId",
          matchup: "$_fingerprintMatchup",
          playerRace: "$_fingerprintMyRace",
        },
        // $topN keeps memory bounded to the same latest-50 window used by the
        // live service and accepts its date + _id deterministic tie-break.
        rows: {
          $topN: {
            n: PLAYER_WINDOW_GAMES,
            sortBy: { date: -1, _id: -1 },
            output: {
              myBuild: "$myBuild",
              durationSec: "$durationSec",
              result: "$result",
            },
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        userId: "$_id.userId",
        matchup: "$_id.matchup",
        playerRace: "$_id.playerRace",
        rows: 1,
      },
    },
  ];
}

/**
 * Convert transient per-player windows into persisted aggregate-only rows.
 * Exported for deterministic unit tests and offline calibration tooling.
 *
 * @param {Array<Record<string, any>>} windowGroups
 * @param {Date} updatedAt
 */
function buildCalibrationRows(windowGroups, updatedAt) {
  /** @type {Map<string, ReturnType<typeof newMatchupAccumulator>>} */
  const matchupAccumulators = new Map();
  /** @type {Map<string, Map<string, {rowsByMatchup: Record<string, any[]>}>>} */
  const players = new Map();
  let playerMatchupWindows = 0;

  for (const group of Array.isArray(windowGroups) ? windowGroups : []) {
    const userId = typeof group.userId === "string" ? group.userId : "";
    const matchup = normalizeMatchup(group.matchup);
    const playerRace = matchup ? matchup[0] : null;
    const rows = Array.isArray(group.rows) ? group.rows : [];
    if (!userId || !matchup || !playerRace || rows.length === 0) continue;

    playerMatchupWindows += 1;
    let accumulator = matchupAccumulators.get(matchup);
    if (!accumulator) {
      accumulator = newMatchupAccumulator(matchup);
      matchupAccumulators.set(matchup, accumulator);
    }
    accumulator.n += 1;

    const repertoire = repertoireAxis(rows);
    recordAxis(
      accumulator.axes.repertoire,
      repertoire,
      repertoire && repertoire.detail
        ? repertoire.detail.effectiveBuilds
        : null,
    );
    const pace = paceAxis(rows);
    recordAxis(
      accumulator.axes.pace,
      pace,
      pace && pace.detail ? pace.detail.averageSec : null,
    );

    let races = players.get(userId);
    if (!races) {
      races = new Map();
      players.set(userId, races);
    }
    let profile = races.get(playerRace);
    if (!profile) {
      profile = { rowsByMatchup: {} };
      races.set(playerRace, profile);
    }
    profile.rowsByMatchup[matchup] = rows;
  }

  // Matchup edge needs the selected window and whichever other windows for the
  // same player/race qualify. Compute it only after every window is indexed.
  for (const races of players.values()) {
    for (const [playerRace, profile] of races.entries()) {
      const balance = matchupBalanceAxis(playerRace, profile.rowsByMatchup);
      for (const opponentRace of RACE_LETTERS) {
        const matchup = `${playerRace}v${opponentRace}`;
        if (!Array.isArray(profile.rowsByMatchup[matchup])) continue;
        const accumulator = matchupAccumulators.get(matchup);
        if (!accumulator) continue;
        const edge = matchupEdgeAxis(matchup, balance.matchups);
        recordAxis(
          accumulator.axes.matchup_edge,
          edge,
          edge && edge.detail ? edge.detail.signedEdge : null,
        );
      }
    }
  }

  const docs = [...matchupAccumulators.values()]
    .sort((a, b) => a.matchup.localeCompare(b.matchup))
    .map((accumulator) => shapeCalibrationRow(accumulator, updatedAt));
  return { docs, playerMatchupWindows };
}

/**
 * @param {string} matchup
 * @returns {MatchupAccumulator}
 */
function newMatchupAccumulator(matchup) {
  return {
    matchup,
    n: 0,
    axes: {
      repertoire: newAxisAccumulator("effectiveBuilds"),
      pace: newAxisAccumulator("averageSec"),
      matchup_edge: newAxisAccumulator("signedEdge"),
    },
  };
}

/**
 * @param {string} metric
 * @returns {AxisAccumulator}
 */
function newAxisAccumulator(metric) {
  return {
    metric,
    n: 0,
    valueN: 0,
    histogram: new Map(),
    categoryCounts: new Map(),
  };
}

/**
 * @param {AxisAccumulator} accumulator
 * @param {Record<string, any> | null | undefined} result
 * @param {unknown} rawValue
 * @returns {void}
 */
function recordAxis(accumulator, result, rawValue) {
  if (!result || typeof result.category !== "string" || !result.category) {
    return;
  }
  accumulator.n += 1;
  accumulator.categoryCounts.set(
    result.category,
    (accumulator.categoryCounts.get(result.category) || 0) + 1,
  );
  if (!isFiniteNumber(rawValue)) return;
  const value = Object.is(rawValue, -0) ? 0 : rawValue;
  accumulator.valueN += 1;
  accumulator.histogram.set(
    value,
    (accumulator.histogram.get(value) || 0) + 1,
  );
}

/**
 * @param {MatchupAccumulator} accumulator
 * @param {Date} updatedAt
 * @returns {Record<string, any>}
 */
function shapeCalibrationRow(accumulator, updatedAt) {
  return {
    version: SCHEMA_VERSION,
    matchup: accumulator.matchup,
    n: accumulator.n,
    axes: {
      repertoire: shapeAxisAccumulator(accumulator.axes.repertoire),
      pace: shapeAxisAccumulator(accumulator.axes.pace),
      matchup_edge: shapeAxisAccumulator(accumulator.axes.matchup_edge),
    },
    reference: cloneReferenceMetadata(),
    updatedAt,
    [VERSION_KEY]: SCHEMA_VERSION,
  };
}

/**
 * @param {AxisAccumulator} accumulator
 * @returns {Record<string, any>}
 */
function shapeAxisAccumulator(accumulator) {
  return {
    metric: accumulator.metric,
    n: accumulator.n,
    valueN: accumulator.valueN,
    histogram: [...accumulator.histogram.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([value, count]) => ({ value, count })),
    categoryCounts: Object.fromEntries(
      [...accumulator.categoryCounts.entries()].sort((a, b) =>
        a[0].localeCompare(b[0]),
      ),
    ),
  };
}

function cloneReferenceMetadata() {
  return {
    ...REFERENCE_METADATA,
    window: { ...REFERENCE_METADATA.window },
  };
}

/**
 * Empirical CDF percentile using the midpoint of the tied block:
 * ``(values below + 0.5 * values equal) / n``.
 *
 * Values between observed points use the ordinary empirical CDF. Returns a
 * fraction in 0..1, or null for malformed/empty input.
 *
 * @param {Array<{value:number,count:number}>} histogram
 * @param {number} value
 * @returns {number | null}
 */
function midrankPercentile(histogram, value) {
  if (!isFiniteNumber(value)) return null;
  const normalized = normalizeHistogram(histogram);
  if (!normalized) return null;
  let below = 0;
  for (const point of normalized.points) {
    if (value < point.value) return below / normalized.n;
    if (value === point.value) {
      return (below + point.count / 2) / normalized.n;
    }
    below += point.count;
  }
  return 1;
}

/**
 * Two-sided extremeness derived from an empirical percentile. Median values
 * score 0; either tail approaches 1.
 *
 * @param {Array<{value:number,count:number}>} histogram
 * @param {number} value
 * @returns {number | null}
 */
function twoSidedPercentileScore(histogram, value) {
  const percentile = midrankPercentile(histogram, value);
  return percentile === null ? null : clamp01(Math.abs(2 * percentile - 1));
}

/**
 * Population-calibrated distinctiveness for one already-rated axis result.
 * Missing, malformed, or under-50 calibration returns null. There is
 * deliberately no marker-distance fallback.
 *
 * Pace nuance: a cheeser selected by the new dominant-under-five signature is
 * tier-rarity scored; a legacy/mean-fallback cheeser remains a continuous
 * average-duration score.
 *
 * @param {Record<string, any> | null | undefined} table
 * @param {string} axisKey
 * @param {Record<string, any> | null | undefined} result
 * @returns {number | null}
 */
function scoreAxis(table, axisKey, result) {
  if (
    !table ||
    !table.axes ||
    !result ||
    typeof result.category !== "string" ||
    !result.category
  ) {
    return null;
  }
  const axisTable = table.axes[axisKey];
  if (!axisTable || typeof axisTable !== "object") return null;
  const detail = result.detail && typeof result.detail === "object"
    ? result.detail
    : {};

  if (axisKey === "repertoire") {
    return scoreContinuous(
      axisTable,
      isFiniteNumber(detail.effectiveBuilds)
        ? detail.effectiveBuilds
        : null,
    );
  }

  if (axisKey === "pace") {
    const category = result.category;
    const dominantCheeser =
      category === "cheeser" &&
      detail.classificationMethod === "dominant_under_five";
    if (dominantCheeser || PACE_RARITY_CATEGORIES.has(category)) {
      return scoreTierRarity(axisTable, category);
    }
    if (
      category === "flexible" ||
      category === "late_game" ||
      category === "cheeser"
    ) {
      const averageSec = firstFiniteNumber(
        detail.averageSec,
        detail.meanSec,
        result.value,
      );
      return scoreContinuous(axisTable, averageSec);
    }
    return null;
  }

  if (axisKey === "matchup_edge") {
    if (MATCHUP_RARITY_CATEGORIES.has(result.category)) {
      return scoreTierRarity(axisTable, result.category);
    }
    if (MATCHUP_CONTINUOUS_CATEGORIES.has(result.category)) {
      const signedEdge = firstFiniteNumber(detail.signedEdge, result.value);
      return scoreContinuous(axisTable, signedEdge);
    }
  }
  return null;
}

/**
 * Metadata-rich form of {@link scoreAxis}. Percentiles and tier frequencies
 * are 0..1 fractions, matching the distinctiveness scale and avoiding an
 * implicit percent-vs-fraction conversion at the API boundary.
 *
 * @param {Record<string, any> | null | undefined} table
 * @param {string} axisKey
 * @param {Record<string, any> | null | undefined} result
 * @returns {{
 *   distinctiveness: number,
 *   method: "two_sided_percentile" | "tier_rarity",
 *   populationSize: number,
 *   percentile?: number,
 *   tierFrequency?: number,
 * } | null}
 */
function scoreAxisCalibration(table, axisKey, result) {
  const distinctiveness = scoreAxis(table, axisKey, result);
  if (distinctiveness === null || !table || !table.axes || !result) {
    return null;
  }
  const axisTable = table.axes[axisKey];
  const mode = scoringMode(axisKey, result);
  if (!axisTable || !mode) return null;

  if (mode === "tier_rarity") {
    const frequency = categoryFrequency(axisTable, result.category);
    if (frequency === null) return null;
    return {
      distinctiveness,
      method: "tier_rarity",
      populationSize: axisTable.n,
      tierFrequency: frequency,
    };
  }

  const value = continuousAxisValue(axisKey, result);
  if (value === null) return null;
  const percentile = midrankPercentile(axisTable.histogram, value);
  if (percentile === null) return null;
  return {
    distinctiveness,
    method: "two_sided_percentile",
    populationSize: axisTable.valueN,
    percentile,
  };
}

/**
 * @param {string} axisKey
 * @param {Record<string, any>} result
 * @returns {"two_sided_percentile" | "tier_rarity" | null}
 */
function scoringMode(axisKey, result) {
  const category = result && result.category;
  const detail = result && result.detail && typeof result.detail === "object"
    ? result.detail
    : {};
  if (axisKey === "repertoire") return "two_sided_percentile";
  if (axisKey === "pace") {
    if (
      (category === "cheeser" &&
        detail.classificationMethod === "dominant_under_five") ||
      PACE_RARITY_CATEGORIES.has(category)
    ) {
      return "tier_rarity";
    }
    if (
      category === "cheeser" ||
      category === "flexible" ||
      category === "late_game"
    ) {
      return "two_sided_percentile";
    }
    return null;
  }
  if (axisKey === "matchup_edge") {
    if (MATCHUP_RARITY_CATEGORIES.has(category)) return "tier_rarity";
    if (MATCHUP_CONTINUOUS_CATEGORIES.has(category)) {
      return "two_sided_percentile";
    }
  }
  return null;
}

/**
 * @param {string} axisKey
 * @param {Record<string, any>} result
 * @returns {number | null}
 */
function continuousAxisValue(axisKey, result) {
  const detail = result && result.detail && typeof result.detail === "object"
    ? result.detail
    : {};
  if (axisKey === "repertoire") {
    return isFiniteNumber(detail.effectiveBuilds)
      ? detail.effectiveBuilds
      : null;
  }
  if (axisKey === "pace") {
    return firstFiniteNumber(detail.averageSec, detail.meanSec, result.value);
  }
  if (axisKey === "matchup_edge") {
    return firstFiniteNumber(detail.signedEdge, result.value);
  }
  return null;
}

/**
 * @param {Record<string, any>} axisTable
 * @param {string} category
 * @returns {number | null}
 */
function categoryFrequency(axisTable, category) {
  if (
    !axisTable ||
    !Number.isInteger(axisTable.n) ||
    axisTable.n < MIN_POPULATION_SAMPLE ||
    !axisTable.categoryCounts ||
    typeof axisTable.categoryCounts !== "object"
  ) {
    return null;
  }
  let total = 0;
  for (const count of Object.values(axisTable.categoryCounts)) {
    if (!Number.isInteger(count) || count < 0) return null;
    total += count;
  }
  if (total !== axisTable.n) return null;
  const count = axisTable.categoryCounts[category] || 0;
  if (!Number.isInteger(count) || count < 0 || count > axisTable.n) {
    return null;
  }
  return count / axisTable.n;
}

/**
 * @param {Record<string, any>} axisTable
 * @param {unknown} value
 * @returns {number | null}
 */
function scoreContinuous(axisTable, value) {
  if (
    !isFiniteNumber(value) ||
    !Number.isInteger(axisTable.valueN) ||
    axisTable.valueN < MIN_POPULATION_SAMPLE
  ) {
    return null;
  }
  const normalized = normalizeHistogram(axisTable.histogram);
  if (!normalized || normalized.n !== axisTable.valueN) return null;
  return twoSidedPercentileScore(normalized.points, value);
}

/**
 * @param {Record<string, any>} axisTable
 * @param {string} category
 * @returns {number | null}
 */
function scoreTierRarity(axisTable, category) {
  const frequency = categoryFrequency(axisTable, category);
  return frequency === null ? null : clamp01(1 - frequency);
}

/**
 * @param {unknown} histogram
 * @returns {{ points: HistogramPoint[], n: number } | null}
 */
function normalizeHistogram(histogram) {
  if (!Array.isArray(histogram) || histogram.length === 0) return null;
  /** @type {Map<number, number>} */
  const combined = new Map();
  for (const point of histogram) {
    if (
      !point ||
      !isFiniteNumber(point.value) ||
      !Number.isInteger(point.count) ||
      point.count <= 0
    ) {
      return null;
    }
    const value = Object.is(point.value, -0) ? 0 : point.value;
    combined.set(value, (combined.get(value) || 0) + point.count);
  }
  const points = [...combined.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, count]) => ({ value, count }));
  const n = points.reduce((sum, point) => sum + point.count, 0);
  return n > 0 ? { points, n } : null;
}

/** @param {unknown} raw @returns {string | null} */
function normalizeMatchup(raw) {
  if (typeof raw !== "string") return null;
  const match = /^([ptz])\s*v\s*([ptz])$/i.exec(raw.trim());
  if (!match) return null;
  return `${match[1].toUpperCase()}v${match[2].toUpperCase()}`;
}

/** @param {...unknown} values @returns {number | null} */
function firstFiniteNumber(...values) {
  for (const value of values) {
    if (isFiniteNumber(value)) return value;
  }
  return null;
}

/** @param {unknown} value @returns {value is number} */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** @param {number} value @returns {number} */
function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

module.exports = {
  FingerprintPopulationCalibrationService,
  buildPlayerWindowsPipeline,
  buildCalibrationRows,
  midrankPercentile,
  twoSidedPercentileScore,
  scoreAxis,
  scoreAxisCalibration,
  COLLECTION_NAME,
  SCHEMA_VERSION,
  MIN_POPULATION_SAMPLE,
  PLAYER_WINDOW_GAMES,
  REFERENCE_METADATA,
};
