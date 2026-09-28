"use strict";

/**
 * Assembles the guide_stats documents of one nightly run from the
 * per-matchup aggregation results (pure; no I/O):
 *
 *   build   — `build:${era}:${matchup}:${buildSlug}`, one per catalog
 *             build of the matchup's builds namespace and era;
 *   matchup — `matchup:${era}:${matchup}`, the openers table + counters;
 *   counter — `counter:${era}:${matchup}:${strategySlug}`, one per
 *             catalog strategy of the matchup's counters namespace;
 *   map     — `map:${era}:${mapSlug}`, per map with ≥ 1 floor-clearing
 *             matchup cell.
 *
 * Numbers follow services/guideStatsShape.js (CELL floor, Wilson
 * ranking); ``published`` applies the PAGE floor. No doc carries a
 * userId, gameId, opponent name, pulse id or toon handle — the inputs
 * never contained them.
 */

const {
  GUIDE_PAGE_MIN_GAMES,
  GUIDE_PAGE_MIN_USERS,
} = require("../config/guides");
const {
  MATCHUPS,
  buildNamesForMatchup,
  strategyNamesForMatchup,
  buildSlug,
  strategySlug,
  mapSlug,
} = require("../config/guideSlugs");
const { PATCH_ERAS } = require("../util/patchEra");
const {
  meetsCellFloor,
  meetsPageFloor,
  toCell,
  compareByCiLow,
  rowKey,
  indexRows,
  historyFields,
  shapeBuildNumbers,
  buildDocKey,
  requireBuildSlug,
} = require("./guideStatsShape");
const { shapeTimings, shapeArmy } = require("./guideStatsSamplesShape");

/** Openers listed per matchup on a map page. */
const MAP_OPENERS_MAX = 3;
const GAMES_FACETS = Object.freeze([
  "overall", "leagueBands", "mmrBands", "maps", "strategies", "lengths", "macro", "leaks",
]);

/** @typedef {Record<string, any>} Row */
/** @typedef {Record<string, any>} GuideStatsDoc */

/**
 * @typedef {object} MatchupResult
 * @property {string} matchup
 * @property {Record<string, Row[]>} facet   games ``$facet`` families
 * @property {Row[]} sampleBuilds            ``{ era, build, games, users }``
 * @property {Row[]} sampleCheckpoints       ``{ era, build, checkpoint, games, users }``
 * @property {Row[]} milestones              milestone quantile rows
 * @property {Row[]} army                    army unit rows
 */

/**
 * @typedef {object} ShapeContext
 * @property {Date} computedAt
 * @property {Map<string, Row>} priors         previous build docs by key
 * @property {Map<string, string>} canonicalMaps ``era␀mapSlug`` → map name
 */

/**
 * @param {Row[]} rows
 * @param {string} era
 * @returns {Row|undefined}
 */
function rowForEra(rows, era) {
  return rows.find((row) => row.era === era);
}

/**
 * Pick one display name per (era, mapSlug): the name with the most
 * floor-clearing games across matchups (ties: alphabetical). Rows under
 * any other spelling of the same slug are dropped — under-reporting a
 * rare variant beats double-publishing one map.
 *
 * @param {MatchupResult[]} results
 * @returns {Map<string, string>}
 */
function canonicalMapNames(results) {
  /** @type {Map<string, Map<string, number>>} */
  const gamesByName = new Map();
  for (const result of results) {
    for (const row of result.facet.mapTotals || []) {
      const slug = mapSlug(row.map);
      if (!slug) continue;
      const key = rowKey(row.era, slug);
      const names = gamesByName.get(key) || new Map();
      names.set(row.map, (names.get(row.map) || 0) + row.games);
      gamesByName.set(key, names);
    }
  }
  /** @type {Map<string, string>} */
  const canonical = new Map();
  for (const [key, names] of gamesByName) {
    const ranked = [...names].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    canonical.set(key, ranked[0][0]);
  }
  return canonical;
}

/**
 * @param {MatchupResult} result
 * @returns {(family: string, era: string, build: string) => Row[]}
 */
function buildRowLookup(result) {
  /** @type {Map<string, Map<string, Row[]>>} */
  const families = new Map();
  for (const family of GAMES_FACETS) families.set(family, indexRows(result.facet[family], ["era", "build"]));
  families.set("sampleBuilds", indexRows(result.sampleBuilds, ["era", "build"]));
  families.set("sampleCheckpoints", indexRows(result.sampleCheckpoints, ["era", "build"]));
  families.set("milestones", indexRows(result.milestones, ["era", "build"]));
  families.set("army", indexRows(result.army, ["era", "build"]));
  return (family, era, build) => {
    const index = families.get(family);
    return (index && index.get(rowKey(era, build))) || [];
  };
}

/**
 * Build docs (every catalog build × era) of one matchup.
 *
 * @param {MatchupResult} result
 * @param {ShapeContext} context
 * @returns {GuideStatsDoc[]}
 */
function shapeBuildDocs(result, context) {
  const { matchup } = result;
  const lookup = buildRowLookup(result);
  /** @type {GuideStatsDoc[]} */
  const docs = [];
  for (const era of PATCH_ERAS) {
    const matchupTotal = rowForEra(result.facet.matchupTotals || [], era);
    for (const buildKey of buildNamesForMatchup(matchup)) {
      const slug = requireBuildSlug(matchup, buildKey);
      const key = buildDocKey(era, matchup, slug);
      const rowsOf = (/** @type {string} */ family) => lookup(family, era, buildKey);
      const numbers = shapeBuildNumbers({ matchup, era, buildKey }, rowsOf, {
        matchupTotal, canonicalMaps: context.canonicalMaps,
      });
      const history = historyFields(numbers, context.priors.get(key), context.computedAt);
      const { published, ...sections } = numbers;
      docs.push({
        kind: "build", key, era, matchup, buildKey, buildSlug: slug,
        published, firstPublishedAt: history.firstPublishedAt,
        ...sections,
        timings: shapeTimings(rowsOf("sampleBuilds")[0], rowsOf("milestones"), matchup),
        army: shapeArmy(rowsOf("sampleCheckpoints"), rowsOf("army")),
        baseline: history.baseline, baselineCandidate: history.baselineCandidate,
        trend: history.trend, isNew: history.isNew,
        examples: [],
        computedAt: context.computedAt,
      });
    }
  }
  return docs;
}

/**
 * Counter docs (every catalog opponent strategy × era) of one matchup.
 *
 * @param {MatchupResult} result
 * @param {Date} computedAt
 * @returns {GuideStatsDoc[]}
 */
function shapeCounterDocs(result, computedAt) {
  const { matchup } = result;
  const totals = indexRows(result.facet.strategyTotals, ["era", "strategy"]);
  const perBuild = indexRows(result.facet.strategies, ["era", "strategy"]);
  /** @type {GuideStatsDoc[]} */
  const docs = [];
  for (const era of PATCH_ERAS) {
    for (const strategyKey of strategyNamesForMatchup(matchup)) {
      const slug = /** @type {string} */ (strategySlug(matchup, strategyKey));
      const overall = toCell((totals.get(rowKey(era, strategyKey)) || [])[0]);
      docs.push({
        kind: "counter", key: `counter:${era}:${matchup}:${slug}`, era, matchup,
        strategyKey, strategySlug: slug,
        published: meetsPageFloor(overall),
        overall,
        openers: openerCells(perBuild.get(rowKey(era, strategyKey)) || [], matchup),
        computedAt,
      });
    }
  }
  return docs;
}

/**
 * Floor-clearing per-build cells, ranked by Wilson lower bound.
 *
 * @param {Row[]} rows ``{ build, games, users, wins, losses }``
 * @param {string} matchup
 * @returns {Array<import('./guideStatsShape').GuideCell & { buildKey: string, buildSlug: string }>}
 */
function openerCells(rows, matchup) {
  /** @type {Array<import('./guideStatsShape').GuideCell & { buildKey: string, buildSlug: string }>} */
  const out = [];
  for (const row of rows) {
    const cell = toCell(row);
    const slug = buildSlug(matchup, row.build);
    if (cell && slug) out.push({ ...cell, buildKey: row.build, buildSlug: slug });
  }
  return out.sort((a, b) => compareByCiLow(a, b, a.buildKey, b.buildKey));
}

/**
 * @param {{ published: boolean, games: number|null, strategyKey: string }} a
 * @param {{ published: boolean, games: number|null, strategyKey: string }} b
 * @returns {number} published first, then games desc (none last), then name
 */
function compareCounters(a, b) {
  if (a.published !== b.published) return a.published ? -1 : 1;
  const gamesA = a.games === null ? -1 : a.games;
  const gamesB = b.games === null ? -1 : b.games;
  if (gamesA !== gamesB) return gamesB - gamesA;
  return a.strategyKey < b.strategyKey ? -1 : 1;
}

/**
 * The matchup doc of one era: openers table (floor-clearing builds,
 * ci.low desc) and the counter list (published first).
 *
 * @param {MatchupResult} result
 * @param {string} era
 * @param {{ builds: GuideStatsDoc[], counters: GuideStatsDoc[], computedAt: Date }} docs same-era docs of the matchup
 * @returns {GuideStatsDoc}
 */
function shapeMatchupDoc(result, era, docs) {
  const total = rowForEra(result.facet.matchupTotals || [], era);
  const builds = docs.builds
    .filter((doc) => doc.overall)
    .map((doc) => ({
      buildKey: doc.buildKey, buildSlug: doc.buildSlug, published: doc.published,
      games: doc.overall.games, users: doc.overall.users, wins: doc.overall.wins,
      winRate: doc.overall.winRate, ci: doc.overall.ci,
      prevalence: doc.prevalence, trend: doc.trend, isNew: doc.isNew,
    }))
    .sort((a, b) => compareByCiLow(a, b, a.buildKey, b.buildKey));
  const counters = docs.counters
    .map((doc) => ({
      strategyKey: doc.strategyKey, strategySlug: doc.strategySlug, published: doc.published,
      games: doc.overall ? doc.overall.games : null,
    }))
    .sort(compareCounters);
  const hasTotal = Boolean(total) && meetsCellFloor(total);
  return {
    kind: "matchup", key: `matchup:${era}:${result.matchup}`, era, matchup: result.matchup,
    games: hasTotal ? /** @type {Row} */ (total).games : null,
    users: hasTotal ? /** @type {Row} */ (total).users : null,
    published: builds.some((build) => build.published),
    builds, counters,
    computedAt: docs.computedAt,
  };
}

/**
 * One map's per-matchup cells (MATCHUPS order) with the top openers.
 *
 * @param {MatchupResult[]} results
 * @param {string} era
 * @param {string} map canonical name
 * @returns {Row[]}
 */
function mapMatchupCells(results, era, map) {
  const out = [];
  for (const result of results) {
    const total = (result.facet.mapTotals || []).find((row) => row.era === era && row.map === map);
    const cell = toCell(total);
    if (!cell) continue;
    const rows = (result.facet.maps || []).filter((row) => row.era === era && row.map === map);
    const openers = openerCells(rows, result.matchup).slice(0, MAP_OPENERS_MAX);
    out.push({ ...cell, matchup: result.matchup, openers });
  }
  const order = /** @type {string[]} */ ([...MATCHUPS]);
  return out.sort((a, b) => order.indexOf(a.matchup) - order.indexOf(b.matchup));
}

/**
 * Map docs: published when the floor-clearing matchup cells sum to the
 * page floor and at least one of them has GUIDE_PAGE_MIN_USERS users.
 *
 * @param {MatchupResult[]} results
 * @param {Map<string, string>} canonicalMaps
 * @param {Date} computedAt
 * @returns {GuideStatsDoc[]}
 */
function shapeMapDocs(results, canonicalMaps, computedAt) {
  /** @type {GuideStatsDoc[]} */
  const docs = [];
  for (const [key, map] of canonicalMaps) {
    const era = key.split("\u0000")[0];
    const slug = /** @type {string} */ (mapSlug(map));
    const matchups = mapMatchupCells(results, era, map);
    if (matchups.length === 0) continue;
    const games = matchups.reduce((sum, cell) => sum + cell.games, 0);
    const maxUsers = Math.max(...matchups.map((cell) => cell.users));
    docs.push({
      kind: "map", key: `map:${era}:${slug}`, era, map, mapSlug: slug,
      published: games >= GUIDE_PAGE_MIN_GAMES && maxUsers >= GUIDE_PAGE_MIN_USERS,
      games, matchups, computedAt,
    });
  }
  return docs;
}

module.exports = {
  canonicalMapNames,
  shapeBuildDocs,
  shapeCounterDocs,
  shapeMatchupDoc,
  shapeMapDocs,
};
