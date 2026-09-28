"use strict";

/**
 * Pure shaping of guide_stats "build" documents from the grouped rows the
 * aggregations in services/guideStatsPipelines.js return. No I/O.
 *
 * Every number emitted is a Cell that clears the CELL floor
 * (GUIDE_CELL_MIN_GAMES games from GUIDE_CELL_MIN_USERS distinct users);
 * anything below it is omitted, never padded. ``winRate`` is over decided
 * games (wins / (wins + losses)), ``ci`` the 95% Wilson interval over the
 * same, all fractions rounded to 4 dp. Lists are ranked by ``ci.low``.
 */

const {
  GUIDE_CELL_MIN_GAMES,
  GUIDE_CELL_MIN_USERS,
  GUIDE_PAGE_MIN_GAMES,
  GUIDE_PAGE_MIN_USERS,
  GUIDE_LENGTH_BUCKETS,
  GUIDE_BASELINE_MIN_AGE_MS,
} = require("../config/guides");
const { buildSlug, strategySlug, mapSlug } = require("../config/guideSlugs");
const { round4, wilsonInterval } = require("../util/wilson");
const { leagueLabel, mmrBandLabel } = require("./guideRules");

/** Macro score decimals (0..100 scale). */
const MACRO_SCORE_DP_SCALE = 10;
const KEY_SEPARATOR = "\u0000";
/**
 * A baseline older than this no longer describes "last week" (runs were
 * paused, or the build sat below the floor for weeks): the trend is
 * withheld instead of comparing against a months-old snapshot.
 */
const BASELINE_STALE_MS = 3 * GUIDE_BASELINE_MIN_AGE_MS;

/**
 * @typedef {object} GuideCell
 * @property {number} games    all games in the cell (ties included)
 * @property {number} users    distinct contributing users
 * @property {number} wins
 * @property {number} winRate  wins / decided, 4 dp
 * @property {{ low: number, high: number }} ci 95% Wilson over decided games
 */

/** @typedef {Record<string, any>} Row grouped aggregation row */

/** @typedef {{ name: string, games: number, users: number, share: number }} GuideLeakItem */

/**
 * @typedef {object} GuideBaseline
 * @property {number} games
 * @property {number} winRate
 * @property {number|null} prevalence
 * @property {Date} at
 */

/**
 * @typedef {object} GuideTrend
 * @property {number} winRateDelta
 * @property {number|null} prevalenceDelta
 * @property {Date} since
 */

/**
 * @param {unknown} row
 * @returns {boolean} games/users meet the CELL floor
 */
function meetsCellFloor(row) {
  if (!row || typeof row !== "object") return false;
  const r = /** @type {Row} */ (row);
  return Number(r.games) >= GUIDE_CELL_MIN_GAMES && Number(r.users) >= GUIDE_CELL_MIN_USERS;
}

/**
 * @param {{ games: number, users: number }|null} cell
 * @returns {boolean} games/users meet the PAGE floor
 */
function meetsPageFloor(cell) {
  return Boolean(cell) && /** @type {{games: number}} */ (cell).games >= GUIDE_PAGE_MIN_GAMES
    && /** @type {{users: number}} */ (cell).users >= GUIDE_PAGE_MIN_USERS;
}

/**
 * Cell of a grouped row, or null below the floor / with no decided game.
 *
 * Example: `toCell({ games: 40, users: 6, wins: 24, losses: 16 })` →
 * `{ games: 40, users: 6, wins: 24, winRate: 0.6, ci: { low: 0.446, high: 0.7365 } }`.
 *
 * @param {Row|null|undefined} row ``{ games, users, wins, losses }``
 * @returns {GuideCell|null}
 */
function toCell(row) {
  if (!row || !meetsCellFloor(row)) return null;
  const decided = Number(row.wins) + Number(row.losses);
  const ci = wilsonInterval(Number(row.wins), decided);
  if (!ci) return null;
  return {
    games: row.games,
    users: row.users,
    wins: row.wins,
    winRate: round4(row.wins / decided),
    ci,
  };
}

/**
 * Rank by Wilson lower bound, then games, then the tie-break label.
 *
 * @param {{ ci: { low: number }, games: number }} a
 * @param {{ ci: { low: number }, games: number }} b
 * @param {string} [aLabel]
 * @param {string} [bLabel]
 * @returns {number}
 */
function compareByCiLow(a, b, aLabel = "", bLabel = "") {
  if (b.ci.low !== a.ci.low) return b.ci.low - a.ci.low;
  if (b.games !== a.games) return b.games - a.games;
  if (aLabel < bLabel) return -1;
  return aLabel > bLabel ? 1 : 0;
}

/**
 * @param {...unknown} parts
 * @returns {string} composite map key
 */
function rowKey(...parts) {
  return parts.map((p) => String(p)).join(KEY_SEPARATOR);
}

/**
 * Index rows by some of their fields.
 *
 * @param {Row[]|undefined} rows
 * @param {string[]} fields
 * @returns {Map<string, Row[]>}
 */
function indexRows(rows, fields) {
  /** @type {Map<string, Row[]>} */
  const index = new Map();
  for (const row of rows || []) {
    const key = rowKey(...fields.map((f) => row[f]));
    const list = index.get(key);
    if (list) list.push(row);
    else index.set(key, [row]);
  }
  return index;
}

/**
 * Band cells (league or MMR), ascending by band value.
 *
 * @param {Row[]} rows ``{ value, games, users, wins, losses }``
 * @param {(value: number) => string|null} labelOf
 * @returns {Array<GuideCell & { value: number, label: string }>}
 */
function shapeBandCells(rows, labelOf) {
  /** @type {Array<GuideCell & { value: number, label: string }>} */
  const out = [];
  for (const row of rows) {
    const cell = toCell(row);
    const label = typeof row.value === "number" ? labelOf(row.value) : null;
    if (cell && label) out.push({ ...cell, value: row.value, label });
  }
  return out.sort((a, b) => a.value - b.value);
}

/**
 * Headline: the league band with the most games clearing the floor, else
 * the overall cell.
 *
 * @param {Array<GuideCell & { value: number, label: string }>} leagueCells
 * @param {GuideCell|null} overall
 * @returns {{ scope: "league"|"all", value: number|null, label: string|null, games: number, winRate: number }|null}
 */
function shapeHeadline(leagueCells, overall) {
  let best = null;
  for (const cell of leagueCells) {
    if (!best || cell.games > best.games) best = cell;
  }
  if (best) {
    return { scope: "league", value: best.value, label: best.label, games: best.games, winRate: best.winRate };
  }
  if (!overall) return null;
  return { scope: "all", value: null, label: null, games: overall.games, winRate: overall.winRate };
}

/**
 * @param {Row[]} rows ``{ strategy, … }``
 * @param {string} matchup
 * @returns {Array<GuideCell & { strategyKey: string, strategySlug: string }>}
 */
function shapeVsStrategy(rows, matchup) {
  /** @type {Array<GuideCell & { strategyKey: string, strategySlug: string }>} */
  const out = [];
  for (const row of rows) {
    const cell = toCell(row);
    const slug = strategySlug(matchup, row.strategy);
    if (cell && slug) out.push({ ...cell, strategyKey: row.strategy, strategySlug: slug });
  }
  return out.sort((a, b) => compareByCiLow(a, b, a.strategyKey, b.strategyKey));
}

/**
 * @param {Row[]} rows ``{ bucket, … }``
 * @returns {Array<GuideCell & { bucket: string, minSec: number, maxSec: number|null }>}
 */
function shapeLengths(rows) {
  const byBucket = new Map(rows.map((row) => [row.bucket, row]));
  /** @type {Array<GuideCell & { bucket: string, minSec: number, maxSec: number|null }>} */
  const out = [];
  for (const bucket of GUIDE_LENGTH_BUCKETS) {
    const cell = toCell(byBucket.get(bucket.key));
    if (cell) out.push({ ...cell, bucket: bucket.key, minSec: bucket.minSec, maxSec: bucket.maxSec });
  }
  return out;
}

/**
 * Map cells under their canonical names (see canonicalMapNames).
 *
 * @param {Row[]} rows ``{ era, map, … }``
 * @param {Map<string, string>} canonical ``era␀mapSlug`` → canonical map name
 * @returns {Array<GuideCell & { map: string, mapSlug: string }>}
 */
function shapeMaps(rows, canonical) {
  /** @type {Array<GuideCell & { map: string, mapSlug: string }>} */
  const out = [];
  for (const row of rows) {
    const slug = mapSlug(row.map);
    const cell = toCell(row);
    if (cell && slug && canonical.get(rowKey(row.era, slug)) === row.map) {
      out.push({ ...cell, map: row.map, mapSlug: slug });
    }
  }
  return out.sort((a, b) => compareByCiLow(a, b, a.mapSlug, b.mapSlug));
}

/**
 * @param {Row|undefined} row ``{ avgScore, games, users }``
 * @returns {{ avgScore: number, games: number, users: number }|null}
 */
function shapeMacro(row) {
  if (!row || !meetsCellFloor(row) || typeof row.avgScore !== "number") return null;
  return {
    avgScore: Math.round(row.avgScore * MACRO_SCORE_DP_SCALE) / MACRO_SCORE_DP_SCALE,
    games: row.games,
    users: row.users,
  };
}

/**
 * Common leaks: ``share`` = scored games with the leak / scored games (a
 * scored game without a leak entry was clean in that category — the
 * services/macroReport.js semantics).
 *
 * @param {Row|undefined} total ``{ games, users }`` scored games (numeric macroScore)
 * @param {Row[]} items ``{ name, games, users }`` scored games per allowlisted leak
 * @returns {{ games: number, users: number, items: GuideLeakItem[] }|null}
 */
function shapeLeaks(total, items) {
  if (!total || !meetsCellFloor(total)) return null;
  const shaped = items
    .filter((item) => meetsCellFloor(item) && typeof item.name === "string")
    .map((item) => ({ name: item.name, games: item.games, users: item.users, share: round4(item.games / total.games) }))
    .sort((a, b) => b.games - a.games || (a.name < b.name ? -1 : 1));
  return { games: total.games, users: total.users, items: shaped };
}

/**
 * Snapshot of a build's numbers at ``at`` (null without an overall cell).
 *
 * @param {{ overall: GuideCell|null, prevalence: number|null }} current
 * @param {Date} at
 * @returns {GuideBaseline|null}
 */
function snapshotOf(current, at) {
  if (!current.overall) return null;
  return {
    games: current.overall.games,
    winRate: current.overall.winRate,
    prevalence: typeof current.prevalence === "number" ? current.prevalence : null,
    at,
  };
}

/**
 * @param {unknown} value a stored snapshot
 * @returns {GuideBaseline|null} the snapshot when well-formed
 */
function validSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  const snap = /** @type {Row} */ (value);
  const ok = snap.at instanceof Date && typeof snap.games === "number" && typeof snap.winRate === "number";
  return ok ? /** @type {GuideBaseline} */ (snap) : null;
}

/**
 * Week-over-week baseline in two slots, so the baseline is always a real
 * snapshot at least GUIDE_BASELINE_MIN_AGE_MS old:
 *   - ``candidate``: the numbers of some earlier run (the first run seeds
 *     it with its own numbers);
 *   - once the candidate is GUIDE_BASELINE_MIN_AGE_MS old it is promoted
 *     to ``baseline`` and this run's numbers become the new candidate.
 * Reruns inside the week change neither slot (idempotent), and the
 * baseline is 7–14 days old with nightly runs; one older than
 * BASELINE_STALE_MS is dropped (no trend) rather than shown as "weekly".
 *
 * Example: a prior doc whose candidate was taken 7 days ago →
 * `{ baseline: prior.baselineCandidate, candidate: <this run's numbers> }`;
 * a rerun an hour later → both slots carried unchanged.
 *
 * @param {Row|undefined} prior previous doc with the same key
 * @param {{ overall: GuideCell|null, prevalence: number|null }} current
 * @param {Date} computedAt this run's stamp
 * @returns {{ baseline: GuideBaseline|null, candidate: GuideBaseline|null }}
 */
function nextBaselines(prior, current, computedAt) {
  const nowMs = computedAt.getTime();
  const fresh = snapshotOf(current, computedAt);
  const priorCandidate = prior ? validSnapshot(prior.baselineCandidate) : null;
  let baseline = prior ? validSnapshot(prior.baseline) : null;
  let candidate = priorCandidate || fresh;
  if (priorCandidate && nowMs - priorCandidate.at.getTime() >= GUIDE_BASELINE_MIN_AGE_MS) {
    baseline = priorCandidate;
    candidate = fresh;
  }
  if (baseline && nowMs - baseline.at.getTime() > BASELINE_STALE_MS) baseline = null;
  return { baseline, candidate };
}

/**
 * @param {GuideCell|null} overall
 * @param {number|null} prevalence
 * @param {GuideBaseline|null} baseline
 * @returns {GuideTrend|null}
 */
function trendOf(overall, prevalence, baseline) {
  if (!overall || !baseline) return null;
  const prevalenceDelta = prevalence !== null && typeof baseline.prevalence === "number"
    ? round4(prevalence - baseline.prevalence)
    : null;
  return { winRateDelta: round4(overall.winRate - baseline.winRate), prevalenceDelta, since: baseline.at };
}

/**
 * History fields of a build doc: baseline/candidate/trend (week over
 * week), isNew and the carried-forward firstPublishedAt.
 *
 * isNew means "newly published, so no weekly trend yet" (the page says
 * exactly that): published now, FIRST published less than
 * GUIDE_BASELINE_MIN_AGE_MS ago, and no trend. Derived from the carried
 * firstPublishedAt rather than the previous run, so a rerun does not clear
 * it, a build that drops under the page floor and re-crosses it is not
 * re-announced, and a build whose pre-publish snapshots already give a
 * trend shows that trend instead.
 *
 * @param {{ published: boolean, overall: GuideCell|null, prevalence: number|null }} current
 * @param {Row|undefined} prior
 * @param {Date} computedAt
 * @returns {{
 *   baseline: GuideBaseline|null, baselineCandidate: GuideBaseline|null, trend: GuideTrend|null,
 *   isNew: boolean, firstPublishedAt: Date|null,
 * }}
 */
function historyFields(current, prior, computedAt) {
  const { baseline, candidate } = nextBaselines(prior, current, computedAt);
  const priorFirst = prior && prior.firstPublishedAt instanceof Date ? prior.firstPublishedAt : null;
  const firstPublishedAt = priorFirst || (current.published ? computedAt : null);
  const trend = trendOf(current.overall, current.prevalence, baseline);
  const isRecent = firstPublishedAt !== null
    && computedAt.getTime() - firstPublishedAt.getTime() < GUIDE_BASELINE_MIN_AGE_MS;
  return {
    baseline,
    baselineCandidate: candidate,
    trend,
    isNew: current.published && isRecent && trend === null,
    firstPublishedAt,
  };
}

/**
 * The numeric sections of one (era, matchup, build) build doc.
 *
 * @param {{ matchup: string, era: string, buildKey: string }} id
 * @param {(family: string) => Row[]} rowsOf rows of a games facet family for this build
 * @param {{ matchupTotal: Row|undefined, canonicalMaps: Map<string, string> }} context
 */
function shapeBuildNumbers(id, rowsOf, context) {
  const overall = toCell(rowsOf("overall")[0]);
  const matchupTotal = context.matchupTotal;
  const matchupGames = overall && matchupTotal && meetsCellFloor(matchupTotal) ? matchupTotal.games : null;
  const league = shapeBandCells(rowsOf("leagueBands"), leagueLabel);
  return {
    published: meetsPageFloor(overall),
    overall,
    prevalence: overall && matchupGames ? round4(overall.games / matchupGames) : null,
    matchupGames,
    bands: { league, mmr: shapeBandCells(rowsOf("mmrBands"), mmrBandLabel) },
    headline: shapeHeadline(league, overall),
    vsStrategy: shapeVsStrategy(rowsOf("strategies"), id.matchup),
    lengths: shapeLengths(rowsOf("lengths")),
    maps: shapeMaps(rowsOf("maps"), context.canonicalMaps),
    macro: shapeMacro(rowsOf("macro")[0]),
    leaks: shapeLeaks(rowsOf("macro")[0], rowsOf("leaks")),
  };
}

/**
 * @param {string} era
 * @param {string} matchup
 * @param {string} slug
 * @returns {string}
 */
function buildDocKey(era, matchup, slug) {
  return `build:${era}:${matchup}:${slug}`;
}

/**
 * @param {string} matchup
 * @param {string} buildKey
 * @returns {string} the build's slug (throws for a non-guide build — a programming error)
 */
function requireBuildSlug(matchup, buildKey) {
  const slug = buildSlug(matchup, buildKey);
  if (!slug) throw new Error(`guideStats: "${buildKey}" is not a ${matchup} guide build`);
  return slug;
}

module.exports = {
  meetsCellFloor,
  meetsPageFloor,
  toCell,
  compareByCiLow,
  rowKey,
  indexRows,
  shapeBandCells,
  shapeHeadline,
  shapeVsStrategy,
  shapeLengths,
  shapeMaps,
  shapeMacro,
  shapeLeaks,
  nextBaselines,
  trendOf,
  historyFields,
  shapeBuildNumbers,
  buildDocKey,
  requireBuildSlug,
};
