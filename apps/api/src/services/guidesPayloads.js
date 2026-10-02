"use strict";

/**
 * Pure shaping of the public `/v1/guides/*` payloads from guide_stats
 * docs (services/guideStatsDocs.js). No I/O.
 *
 * Every output object is built from an explicit allowlist — a stored doc
 * is never spread into a response — so internal fields (``baseline``,
 * ``baselineCandidate``, ``key``, ``_schemaVersion``) cannot reach the
 * wire even if a future writer adds more. The docs themselves carry no
 * userId, gameId, opponent name, pulse id or toon handle, and every
 * number in them already clears the CELL floor; unpublished pages get an
 * identity-only payload (no numbers at all). The floors are re-checked
 * here anyway (defense in depth): a stored group below the CELL floor —
 * a writer bug, a hand-edited doc — is dropped, never served.
 */

const {
  GUIDE_CELL_MIN_GAMES,
  GUIDE_PAGE_MIN_GAMES,
  GUIDE_TOP_WINNING,
  GUIDE_PATCH_LABEL,
} = require("../config/guides");
const {
  MATCHUPS,
  guideName,
  matchupSlug,
  strategyNamesForMatchup,
  strategySlug,
} = require("../config/guideSlugs");
const { compareByCiLow, meetsCellFloor } = require("./guideStatsShape");

/** Build rows in the "related" block of a build page. */
const GUIDE_RELATED_MAX = 8;

/** @typedef {Record<string, any>} Doc a guide_stats document (or sub-object) */

/**
 * @typedef {object} GuideCell
 * @property {number} games
 * @property {number} users
 * @property {number} wins
 * @property {number} winRate
 * @property {{ low: number, high: number }} ci
 */

/** @typedef {{ type: "league"|"mmr", value: number, label: string }} GuideBand */

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function numOrNull(value) {
  return isNum(value) ? value : null;
}

/**
 * @param {unknown} value
 * @returns {Date|null}
 */
function dateOrNull(value) {
  return value instanceof Date ? value : null;
}

/**
 * ``games`` / ``users`` of a stored group clear the CELL floor.
 *
 * Example: `clearsCellFloor(40, 6)` → true; `clearsCellFloor(29, 9)` → false.
 *
 * @param {unknown} games
 * @param {unknown} users
 * @returns {boolean}
 */
function clearsCellFloor(games, users) {
  return isNum(games) && isNum(users) && meetsCellFloor({ games, users });
}

/**
 * A game count that clears the CELL floor on its own (rows that carry no
 * user count: counter links, army units, the headline), else null.
 *
 * @param {unknown} games
 * @returns {number|null}
 */
function flooredGames(games) {
  return isNum(games) && games >= GUIDE_CELL_MIN_GAMES ? games : null;
}

/**
 * A Cell copied field by field, or null when malformed or below the
 * CELL floor.
 *
 * @param {unknown} raw
 * @returns {GuideCell|null}
 */
function pickCell(raw) {
  if (!raw || typeof raw !== "object") return null;
  const c = /** @type {Doc} */ (raw);
  if (![c.wins, c.winRate].every(isNum) || !clearsCellFloor(c.games, c.users)) return null;
  if (!c.ci || !isNum(c.ci.low) || !isNum(c.ci.high)) return null;
  return { games: c.games, users: c.users, wins: c.wins, winRate: c.winRate, ci: { low: c.ci.low, high: c.ci.high } };
}

/**
 * A matchup doc's corpus totals, or nulls when absent / below the floor.
 *
 * @param {Doc|null|undefined} doc
 * @returns {{ games: number|null, users: number|null }}
 */
function matchupTotals(doc) {
  if (!doc || !clearsCellFloor(doc.games, doc.users)) return { games: null, users: null };
  return { games: doc.games, users: doc.users };
}

/**
 * Map a list through a picker, dropping malformed rows.
 *
 * @template T
 * @param {unknown} list
 * @param {(row: Doc) => T|null} pick
 * @returns {T[]}
 */
function pickList(list, pick) {
  if (!Array.isArray(list)) return [];
  /** @type {T[]} */
  const out = [];
  for (const row of list) {
    const picked = row && typeof row === "object" ? pick(row) : null;
    if (picked) out.push(picked);
  }
  return out;
}

/**
 * A map doc served as published (stored flag and page-floor games) — the
 * hub list, the map page and the sitemap all apply this one rule.
 *
 * @param {Doc} doc
 * @returns {boolean}
 */
function servesPublishedMap(doc) {
  return doc.published === true && isNum(doc.games) && doc.games >= GUIDE_PAGE_MIN_GAMES;
}

/**
 * @param {unknown} raw
 * @returns {{ winRateDelta: number, prevalenceDelta: number|null, since: Date }|null}
 */
function pickTrend(raw) {
  if (!raw || typeof raw !== "object") return null;
  const t = /** @type {Doc} */ (raw);
  if (!isNum(t.winRateDelta) || !(t.since instanceof Date)) return null;
  return { winRateDelta: t.winRateDelta, prevalenceDelta: numOrNull(t.prevalenceDelta), since: t.since };
}

/**
 * Common identity of every payload.
 *
 * @param {string} era
 * @param {Doc|null} doc
 * @returns {{ era: string, patch: string, computedAt: Date|null }}
 */
function eraFields(era, doc) {
  return { era, patch: GUIDE_PATCH_LABEL, computedAt: doc ? dateOrNull(doc.computedAt) : null };
}

/**
 * @param {Doc} row matchup-doc build row
 * @param {string} matchup the matchup doc's matchup
 * @returns {GuideCell & { buildKey: string, buildSlug: string, name: string, published: boolean,
 *   prevalence: number|null, trend: ReturnType<typeof pickTrend>, isNew: boolean }|null}
 */
function openerRow(row, matchup) {
  const cell = pickCell(row);
  if (!cell || typeof row.buildKey !== "string" || typeof row.buildSlug !== "string") return null;
  return {
    ...cell,
    buildKey: row.buildKey,
    buildSlug: row.buildSlug,
    name: guideName("builds", matchup, row.buildKey),
    published: row.published === true,
    prevalence: numOrNull(row.prevalence),
    trend: pickTrend(row.trend),
    isNew: row.isNew === true,
  };
}

/**
 * A matchup doc's floor-clearing build rows, ranked by Wilson lower bound
 * here rather than trusting the stored order.
 *
 * @param {Doc|null|undefined} doc
 */
function openerRows(doc) {
  const rows = doc ? pickList(doc.builds, (/** @type {Doc} */ row) => openerRow(row, doc.matchup)) : [];
  return rows.sort((a, b) => compareByCiLow(a, b, a.buildKey, b.buildKey));
}

/**
 * One matchup tile of the hub.
 *
 * @param {string} matchup
 * @param {Doc|undefined} doc current-era matchup doc
 */
function indexMatchup(matchup, doc) {
  const builds = openerRows(doc);
  const published = builds.filter((row) => row.published);
  return {
    matchup,
    slug: /** @type {string} */ (matchupSlug(matchup)),
    published: Boolean(doc && doc.published === true),
    ...matchupTotals(doc),
    top: published.slice(0, GUIDE_TOP_WINNING).map((row) => ({
      buildKey: row.buildKey, buildSlug: row.buildSlug, name: row.name,
      games: row.games, users: row.users, winRate: row.winRate, ci: row.ci,
      trend: row.trend, isNew: row.isNew,
    })),
    publishedBuilds: published.length,
  };
}

/**
 * `GET /v1/guides`.
 *
 * @param {{ era: string, computedAt: Date|null, matchupDocs: Doc[], mapDocs: Doc[],
 *   videos: object[], eightWorkerVideos?: object[],
 *   channel: { url: string, name: string }|null,
 *   playlists?: { twelveWorker: string|null, eightWorker: string|null } }} input
 *   `videos`: the 12-worker build order videos; `eightWorkerVideos`: the
 *   8-worker patch ones; `playlists`: the channel's playlist of each
 */
function shapeIndexPayload(input) {
  const byMatchup = new Map(input.matchupDocs.map((doc) => [doc.matchup, doc]));
  const maps = pickList(input.mapDocs, (doc) => (
    servesPublishedMap(doc) && typeof doc.map === "string" && typeof doc.mapSlug === "string"
      ? { map: doc.map, slug: doc.mapSlug, games: doc.games }
      : null
  )).sort((a, b) => b.games - a.games || (a.slug < b.slug ? -1 : 1));
  return {
    computedAt: input.computedAt,
    era: input.era,
    patch: GUIDE_PATCH_LABEL,
    matchups: MATCHUPS.map((matchup) => indexMatchup(matchup, byMatchup.get(matchup))),
    maps,
    videos: input.videos,
    eightWorkerVideos: input.eightWorkerVideos || [],
    channel: input.channel,
    playlists: input.playlists || { twelveWorker: null, eightWorker: null },
  };
}

/**
 * Counter links of a matchup: from the doc, or (before any run) every
 * catalog strategy of the matchup, unpublished and without numbers.
 *
 * @param {string} matchup
 * @param {Doc|null} doc
 */
function counterLinks(matchup, doc) {
  if (!doc) {
    return strategyNamesForMatchup(matchup).map((key) => ({
      strategyKey: key,
      strategySlug: /** @type {string} */ (strategySlug(matchup, key)),
      name: guideName("counters", matchup, key),
      published: false,
      games: null,
    }));
  }
  return pickList(doc.counters, (row) => (
    typeof row.strategyKey === "string" && typeof row.strategySlug === "string"
      ? {
        strategyKey: row.strategyKey,
        strategySlug: row.strategySlug,
        name: guideName("counters", matchup, row.strategyKey),
        published: row.published === true,
        games: flooredGames(row.games),
      }
      : null
  ));
}

/**
 * Band values with at least one floor-clearing cell among the matchup's
 * build docs, ascending, with their labels.
 *
 * @param {Doc[]} buildDocs
 * @returns {{ league: Array<{ value: number, label: string }>, mmr: Array<{ value: number, label: string }> }}
 */
function bandOptionsOf(buildDocs) {
  /** @param {"league"|"mmr"} type */
  const collect = (type) => {
    /** @type {Map<number, string>} */
    const seen = new Map();
    for (const doc of buildDocs) {
      const cells = doc.bands && Array.isArray(doc.bands[type]) ? doc.bands[type] : [];
      for (const cell of cells) {
        if (pickCell(cell) && isNum(cell.value) && typeof cell.label === "string") seen.set(cell.value, cell.label);
      }
    }
    return [...seen].sort((a, b) => a[0] - b[0]).map(([value, label]) => ({ value, label }));
  };
  return { league: collect("league"), mmr: collect("mmr") };
}

/**
 * Openers for one opponent band: each build's band cell (builds without
 * one omitted). Prevalence and trend are whole-matchup numbers, so they
 * are not shown next to a band cell.
 *
 * @param {Doc[]} buildDocs
 * @param {GuideBand} band
 */
function bandOpeners(buildDocs, band) {
  const out = [];
  for (const doc of buildDocs) {
    const cells = doc.bands && Array.isArray(doc.bands[band.type]) ? doc.bands[band.type] : [];
    const cell = pickCell(cells.find((/** @type {Doc} */ c) => c && c.value === band.value));
    if (!cell || typeof doc.buildKey !== "string" || typeof doc.buildSlug !== "string") continue;
    out.push({
      ...cell,
      buildKey: doc.buildKey,
      buildSlug: doc.buildSlug,
      name: guideName("builds", doc.matchup, doc.buildKey),
      published: doc.published === true,
      prevalence: null,
      trend: null,
      isNew: doc.isNew === true,
    });
  }
  return out.sort((a, b) => compareByCiLow(a, b, a.buildKey, b.buildKey));
}

/**
 * `GET /v1/guides/:matchup`.
 *
 * @param {{ matchup: string, era: string, band: GuideBand|null, doc: Doc|null,
 *   buildDocs: Doc[], videos: object[], eightWorkerVideos?: object[] }} input
 *   `videos`: the era's own videos; `eightWorkerVideos`: the matchup's
 *   8-worker patch videos, listed apart on the 12-worker view
 */
function shapeMatchupPayload(input) {
  const { matchup, doc } = input;
  return {
    matchup,
    slug: /** @type {string} */ (matchupSlug(matchup)),
    ...eraFields(input.era, doc),
    published: Boolean(doc && doc.published === true),
    ...matchupTotals(doc),
    band: input.band,
    bandOptions: bandOptionsOf(input.buildDocs),
    openers: input.band ? bandOpeners(input.buildDocs, input.band) : openerRows(doc),
    counters: counterLinks(matchup, doc),
    videos: input.videos,
    eightWorkerVideos: input.eightWorkerVideos || [],
  };
}

/**
 * Published flag per catalog name from a matchup doc's build / counter rows.
 *
 * @param {Doc|null} matchupDoc
 * @param {"builds"|"counters"} list
 * @param {"buildKey"|"strategyKey"} keyField
 * @returns {Set<string>}
 */
function publishedKeys(matchupDoc, list, keyField) {
  const rows = matchupDoc && Array.isArray(matchupDoc[list]) ? matchupDoc[list] : [];
  return new Set(rows.filter((/** @type {Doc} */ r) => r && r.published === true).map((/** @type {Doc} */ r) => r[keyField]));
}

/**
 * Same-matchup builds for the "related" block: published first, then by
 * Wilson lower bound; the page's own build excluded.
 *
 * @param {Doc|null} matchupDoc
 * @param {string} buildKey
 */
function relatedBuilds(matchupDoc, buildKey) {
  return openerRows(matchupDoc)
    .filter((row) => row.buildKey !== buildKey)
    .sort((a, b) => (a.published === b.published ? compareByCiLow(a, b, a.buildKey, b.buildKey) : (a.published ? -1 : 1)))
    .slice(0, GUIDE_RELATED_MAX)
    .map((row) => ({
      buildKey: row.buildKey, buildSlug: row.buildSlug, name: row.name, published: row.published,
      games: row.games, winRate: row.winRate, ci: row.ci,
    }));
}

module.exports = {
  GUIDE_RELATED_MAX,
  isNum,
  numOrNull,
  dateOrNull,
  clearsCellFloor,
  flooredGames,
  pickCell,
  pickList,
  pickTrend,
  eraFields,
  shapeIndexPayload,
  shapeMatchupPayload,
  bandOptionsOf,
  publishedKeys,
  relatedBuilds,
  servesPublishedMap,
};
