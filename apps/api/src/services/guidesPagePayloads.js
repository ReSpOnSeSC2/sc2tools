"use strict";

/**
 * Pure shaping of the page payloads of the public guides API — build,
 * counter and map pages plus the sitemap — from guide_stats docs. No I/O.
 *
 * Same rules as services/guidesPayloads.js: explicit allowlists only
 * (never ``baseline`` / ``baselineCandidate`` or any storage field), and
 * an unpublished page is identity-only: names, catalog prose, era and the
 * owner's own videos, never a number. Floors are re-checked at serve time
 * (defense in depth): a group below the CELL floor is dropped, and a page
 * whose stored ``published`` flag disagrees with its numbers is served as
 * unpublished.
 */

const { GUIDE_MILESTONE_MIN_PRESENCE } = require("../config/guides");
const {
  MATCHUPS,
  RACE_WORDS,
  guideName,
  matchupSlug,
  catalogEntry,
} = require("../config/guideSlugs");
const {
  isNum,
  numOrNull,
  dateOrNull,
  clearsCellFloor,
  flooredGames,
  pickCell,
  pickList,
  pickTrend,
  eraFields,
  publishedKeys,
  relatedBuilds,
  servesPublishedMap,
} = require("./guidesPayloads");
const { meetsPageFloor } = require("./guideStatsShape");

const MY_RACE_INDEX = 0;
const OPP_RACE_INDEX = 2;
/** Army checkpoints (seconds) as stored object keys. */
const ARMY_CHECKPOINT_KEYS = Object.freeze(["360", "480", "600"]);
const HEADLINE_SCOPES = new Set(["league", "all"]);
const MILESTONE_EVENTS = new Set(["start", "finish"]);

/** @typedef {import('./guidesPayloads').Doc} Doc */

/**
 * A build or counter doc served as published: the stored flag AND a
 * page-floor overall cell. A doc whose flag disagrees with its numbers is
 * served — and left out of the sitemap — as unpublished.
 *
 * @param {Doc|null|undefined} doc
 * @returns {boolean}
 */
function servesPublishedCell(doc) {
  return doc != null && doc.published === true && meetsPageFloor(pickCell(doc.overall));
}

/** Sitemap listing rule per doc kind (the same checks the pages apply). */
const SITEMAP_LISTED = Object.freeze({
  matchup: (/** @type {Doc} */ d) => d.published === true,
  build: (/** @type {Doc} */ d) => typeof d.buildSlug === "string" && servesPublishedCell(d),
  counter: (/** @type {Doc} */ d) => typeof d.strategySlug === "string" && servesPublishedCell(d),
  map: (/** @type {Doc} */ d) => typeof d.mapSlug === "string" && servesPublishedMap(d),
});

/**
 * @param {Doc} doc
 * @returns {boolean} the doc's page is published at serve time
 */
function isListedDoc(doc) {
  const kind = typeof doc.kind === "string" && Object.prototype.hasOwnProperty.call(SITEMAP_LISTED, doc.kind)
    ? /** @type {keyof typeof SITEMAP_LISTED} */ (doc.kind)
    : null;
  return kind !== null && SITEMAP_LISTED[kind](doc);
}

/**
 * @param {unknown} raw
 * @returns {{ scope: string, value: number|null, label: string|null, games: number, winRate: number }|null}
 */
function pickHeadline(raw) {
  if (!raw || typeof raw !== "object") return null;
  const h = /** @type {Doc} */ (raw);
  if (!HEADLINE_SCOPES.has(h.scope) || flooredGames(h.games) === null || !isNum(h.winRate)) return null;
  return {
    scope: h.scope,
    value: numOrNull(h.value),
    label: typeof h.label === "string" ? h.label : null,
    games: h.games,
    winRate: h.winRate,
  };
}

/**
 * @param {Doc} row
 * @returns {Doc|null} band cell with its value and label
 */
function bandCell(row) {
  const cell = pickCell(row);
  return cell && isNum(row.value) && typeof row.label === "string"
    ? { ...cell, value: row.value, label: row.label }
    : null;
}

/**
 * @param {unknown} raw
 * @returns {{ games: number, users: number, median: number }|null}
 */
function pickSplit(raw) {
  if (!raw || typeof raw !== "object") return null;
  const s = /** @type {Doc} */ (raw);
  return clearsCellFloor(s.games, s.users) && isNum(s.median)
    ? { games: s.games, users: s.users, median: s.median }
    : null;
}

/**
 * @param {Doc} m
 * @returns {Doc|null}
 */
function pickMilestone(m) {
  const numbers = [m.games, m.users, m.presence, m.p25, m.median, m.p75];
  if (typeof m.key !== "string" || typeof m.label !== "string" || !MILESTONE_EVENTS.has(m.event)) return null;
  if (!numbers.every(isNum) || !clearsCellFloor(m.games, m.users)) return null;
  if (m.presence < GUIDE_MILESTONE_MIN_PRESENCE) return null;
  /** @type {Doc} */
  const out = {
    key: m.key, label: m.label, event: m.event, games: m.games, users: m.users,
    presence: m.presence, p25: m.p25, median: m.median, p75: m.p75,
  };
  const winners = pickSplit(m.winners);
  const losers = pickSplit(m.losers);
  if (winners && losers) {
    out.winners = winners;
    out.losers = losers;
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {{ samples: number, users: number, milestones: Doc[] }|null}
 */
function pickTimings(raw) {
  if (!raw || typeof raw !== "object") return null;
  const t = /** @type {Doc} */ (raw);
  if (!clearsCellFloor(t.samples, t.users)) return null;
  const milestones = pickList(t.milestones, pickMilestone);
  return milestones.length > 0 ? { samples: t.samples, users: t.users, milestones } : null;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, Doc>|null} checkpoints present in the doc only
 */
function pickArmy(raw) {
  if (!raw || typeof raw !== "object") return null;
  const army = /** @type {Doc} */ (raw);
  /** @type {Record<string, Doc>} */
  const out = {};
  for (const key of ARMY_CHECKPOINT_KEYS) {
    const cp = army[key];
    if (!cp || !clearsCellFloor(cp.samples, cp.users)) continue;
    const units = pickList(cp.units, (u) => (
      typeof u.unit === "string" && isNum(u.presence) && isNum(u.median) && flooredGames(u.games) !== null
        ? { unit: u.unit, presence: u.presence, median: u.median, games: u.games }
        : null
    ));
    if (units.length > 0) out[key] = { samples: cp.samples, users: cp.users, units };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * @param {unknown} raw
 * @returns {{ avgScore: number, games: number, users: number }|null}
 */
function pickMacro(raw) {
  if (!raw || typeof raw !== "object") return null;
  const m = /** @type {Doc} */ (raw);
  return isNum(m.avgScore) && clearsCellFloor(m.games, m.users)
    ? { avgScore: m.avgScore, games: m.games, users: m.users }
    : null;
}

/**
 * @param {unknown} raw
 * @returns {{ games: number, users: number, items: Doc[] }|null}
 */
function pickLeaks(raw) {
  if (!raw || typeof raw !== "object") return null;
  const l = /** @type {Doc} */ (raw);
  if (!clearsCellFloor(l.games, l.users)) return null;
  const items = pickList(l.items, (i) => (
    typeof i.name === "string" && clearsCellFloor(i.games, i.users) && isNum(i.share)
      ? { name: i.name, games: i.games, users: i.users, share: i.share }
      : null
  ));
  return { games: l.games, users: l.users, items };
}

/**
 * The numeric sections of a published build doc.
 *
 * @param {Doc} doc
 * @param {Set<string>} publishedCounters strategy keys with a published counter page
 */
function buildSections(doc, publishedCounters) {
  const bands = doc.bands && typeof doc.bands === "object" ? doc.bands : {};
  return {
    overall: pickCell(doc.overall),
    prevalence: numOrNull(doc.prevalence),
    matchupGames: numOrNull(doc.matchupGames),
    headline: pickHeadline(doc.headline),
    bands: { league: pickList(bands.league, bandCell), mmr: pickList(bands.mmr, bandCell) },
    timings: pickTimings(doc.timings),
    army: pickArmy(doc.army),
    vsStrategy: pickList(doc.vsStrategy, (row) => {
      const cell = pickCell(row);
      return cell && typeof row.strategyKey === "string" && typeof row.strategySlug === "string"
        ? {
          ...cell, strategyKey: row.strategyKey, strategySlug: row.strategySlug,
          name: guideName("counters", doc.matchup, row.strategyKey),
          published: publishedCounters.has(row.strategyKey),
        }
        : null;
    }),
    lengths: pickList(doc.lengths, (row) => {
      const cell = pickCell(row);
      return cell && typeof row.bucket === "string" && isNum(row.minSec)
        ? { ...cell, bucket: row.bucket, minSec: row.minSec, maxSec: numOrNull(row.maxSec) }
        : null;
    }),
    maps: pickList(doc.maps, (row) => {
      const cell = pickCell(row);
      return cell && typeof row.map === "string" && typeof row.mapSlug === "string"
        ? { ...cell, map: row.map, mapSlug: row.mapSlug }
        : null;
    }),
    macro: pickMacro(doc.macro),
    leaks: pickLeaks(doc.leaks),
    trend: pickTrend(doc.trend),
    isNew: doc.isNew === true,
    firstPublishedAt: dateOrNull(doc.firstPublishedAt),
  };
}

/**
 * @typedef {object} BuildPageInput
 * @property {string} matchup
 * @property {string} buildKey
 * @property {string} buildSlug
 * @property {string} era
 * @property {Doc|null} doc          the build doc
 * @property {Doc|null} matchupDoc   same-era matchup doc (related, counter flags)
 * @property {object[]} videos
 * @property {object[]} [eightWorkerVideos] the build's 8-worker patch videos
 * @property {Array<{ slug: string, title: string }>} communityBuilds
 * @property {object[]} examples     re-verified examples
 * @property {{ body: string, updatedAt: Date }|null} notes
 */

/**
 * `GET /v1/guides/:matchup/:build`.
 *
 * @param {BuildPageInput} input
 */
function shapeBuildPayload(input) {
  const { matchup, buildKey, doc } = input;
  const entry = catalogEntry(buildKey);
  const identity = {
    published: false,
    matchup,
    matchupSlug: /** @type {string} */ (matchupSlug(matchup)),
    buildKey,
    buildSlug: input.buildSlug,
    name: guideName("builds", matchup, buildKey),
    description: entry ? entry.description : "",
    ...eraFields(input.era, doc),
    videos: input.videos,
    eightWorkerVideos: input.eightWorkerVideos || [],
  };
  if (!doc || !servesPublishedCell(doc)) return identity;
  return {
    ...identity,
    published: true,
    ...buildSections(doc, publishedKeys(input.matchupDoc, "counters", "strategyKey")),
    related: relatedBuilds(input.matchupDoc, buildKey),
    communityBuilds: input.communityBuilds,
    examples: input.examples,
    notes: input.notes,
  };
}

/**
 * `GET /v1/guides/:matchup/counter/:strategy`.
 *
 * @param {{ matchup: string, strategyKey: string, strategySlug: string, era: string,
 *   doc: Doc|null, matchupDoc: Doc|null, videos: object[], eightWorkerVideos?: object[] }} input
 */
function shapeCounterPayload(input) {
  const { matchup, strategyKey, doc } = input;
  const entry = catalogEntry(strategyKey);
  const identity = {
    published: false,
    matchup,
    matchupSlug: /** @type {string} */ (matchupSlug(matchup)),
    strategyKey,
    strategySlug: input.strategySlug,
    name: guideName("counters", matchup, strategyKey),
    description: entry ? entry.description : "",
    myRace: RACE_WORDS[matchup[MY_RACE_INDEX]],
    oppRace: RACE_WORDS[matchup[OPP_RACE_INDEX]],
    ...eraFields(input.era, doc),
    videos: input.videos,
    eightWorkerVideos: input.eightWorkerVideos || [],
  };
  const overall = doc && servesPublishedCell(doc) ? pickCell(doc.overall) : null;
  if (!doc || !overall) return identity;
  const publishedBuilds = publishedKeys(input.matchupDoc, "builds", "buildKey");
  return {
    ...identity,
    published: true,
    overall,
    openers: pickList(doc.openers, (row) => {
      const cell = pickCell(row);
      return cell && typeof row.buildKey === "string" && typeof row.buildSlug === "string"
        ? {
          ...cell, buildKey: row.buildKey, buildSlug: row.buildSlug,
          name: guideName("builds", matchup, row.buildKey), published: publishedBuilds.has(row.buildKey),
        }
        : null;
    }),
  };
}

/**
 * @param {Doc} row map-doc matchup cell
 * @returns {Doc|null}
 */
function mapMatchupRow(row) {
  const cell = pickCell(row);
  const slug = typeof row.matchup === "string" ? matchupSlug(row.matchup) : null;
  if (!cell || !slug) return null;
  const openers = pickList(row.openers, (o) => {
    const c = pickCell(o);
    return c && typeof o.buildKey === "string" && typeof o.buildSlug === "string"
      ? {
        ...c, buildKey: o.buildKey, buildSlug: o.buildSlug, name: guideName("builds", row.matchup, o.buildKey),
      }
      : null;
  });
  return { ...cell, matchup: row.matchup, slug, openers };
}

/**
 * `GET /v1/guides/maps/:map` (the doc exists; a missing doc is a 404).
 *
 * @param {{ era: string, doc: Doc }} input
 */
function shapeMapPayload(input) {
  const { doc } = input;
  const identity = {
    published: false,
    map: String(doc.map),
    mapSlug: String(doc.mapSlug),
    ...eraFields(input.era, doc),
  };
  if (!servesPublishedMap(doc)) return identity;
  return { ...identity, published: true, games: doc.games, matchups: pickList(doc.matchups, mapMatchupRow) };
}

/**
 * Published page paths for the web sitemap, in a stable order.
 *
 * @param {Doc[]} docs published current-era docs ({ kind, matchup, buildSlug, strategySlug, mapSlug })
 * @param {boolean} hubIndexable the hub has published builds or videos
 * @returns {string[]}
 */
function sitemapPaths(docs, hubIndexable) {
  /** @param {string} kind @param {string} [matchup] */
  const of = (kind, matchup) => docs.filter((d) => d.kind === kind && (!matchup || d.matchup === matchup));
  /** @type {string[]} */
  const paths = hubIndexable ? ["/guides"] : [];
  for (const matchup of MATCHUPS) {
    const mu = /** @type {string} */ (matchupSlug(matchup));
    if (of("matchup", matchup).length > 0) paths.push(`/guides/${mu}`);
    for (const d of of("build", matchup)) paths.push(`/guides/${mu}/${d.buildSlug}`);
    const counters = of("counter", matchup);
    if (counters.length > 0) paths.push(`/guides/${mu}/counter`);
    for (const d of counters) paths.push(`/guides/${mu}/counter/${d.strategySlug}`);
  }
  const maps = of("map");
  if (maps.length > 0) paths.push("/guides/maps");
  for (const d of maps) paths.push(`/guides/maps/${d.mapSlug}`);
  return paths;
}

/**
 * `GET /v1/guides/sitemap`: pages the shapers above serve as published
 * (so no listed URL renders "Not enough games yet" + noindex), with
 * lastModified = the run.
 *
 * @param {{ computedAt: Date|null, docs: Doc[], hasVideos: boolean }} input
 */
function shapeSitemapPayload(input) {
  if (!input.computedAt) return { computedAt: null, entries: [] };
  const valid = input.docs.filter(isListedDoc);
  const hubIndexable = valid.some((d) => d.kind === "build") || input.hasVideos;
  const lastModified = input.computedAt;
  return {
    computedAt: input.computedAt,
    entries: sitemapPaths(valid, hubIndexable).map((path) => ({ path, lastModified })),
  };
}

module.exports = {
  ARMY_CHECKPOINT_KEYS,
  shapeBuildPayload,
  shapeCounterPayload,
  shapeMapPayload,
  shapeSitemapPayload,
};
