"use strict";

const { buildSlug } = require("../config/guideSlugs");
const { milestonesForRace } = require("../config/guideMilestones");
const { GUIDE_CURRENT_ERA } = require("../config/guides");
const { eraForGame } = require("../util/patchEra");
const { matchupOf } = require("./guideRules");
const { servesPublishedCell, pickTimings } = require("./guidesPagePayloads");

/** Exact recorded catalog identity only. A private definition sharing its name
 * is not proof that it uses the public guide's classifier.
 * @param {string} name @param {Array<Record<string,any>>} games */
function comparisonTargets(name, games) {
  /** @type {Map<string,Array<Record<string,any>>>} */ const groups = new Map();
  for (const game of games) {
    const matchup = matchupOf(game.myRace, game.opponent?.race);
    if (!matchup || !buildSlug(matchup, name)) continue;
    const rows = groups.get(matchup) || []; rows.push(game); groups.set(matchup, rows);
  }
  return [...groups].flatMap(([matchup, rows]) => {
    if (rows.some(game => game._customBuildSlug || eraForGame(game) !== GUIDE_CURRENT_ERA)) return [];
    const slug = buildSlug(matchup, name);
    return [{ matchup, slug, key: `build:${GUIDE_CURRENT_ERA}:${matchup}:${slug}` }];
  }).slice(0, 9);
}

/** DNA uses first construction starts (morph completion is rewound). Public
 * guides preserve recorded completion and later occurrences. Only equivalent
 * first-start milestones may produce a delta.
 * @param {string} matchup @param {unknown} raw */
function comparableRows(matchup, raw) {
  const timing = pickTimings(raw);
  if (!timing) return [];
  const specs = new Map(milestonesForRace(matchup).filter(row => row.event === "start" && row.occurrence === 1)
    .map(row => [row.key, row]));
  return timing.milestones.flatMap(row => {
    const spec = specs.get(row.key);
    if (!spec || row.event !== "start" || !(row.p25 >= 0 && row.p25 <= row.median && row.median <= row.p75)) return [];
    return [{ token: spec.names[0], p25Seconds: row.p25, medianSeconds: row.median, p75Seconds: row.p75,
      sampleCount: row.games, users: row.users, event: "start" }];
  });
}

/** One optional bounded indexed read; no corpus scan, replay read or provider.
 * Publication floors are rechecked at serve time through the public shaper.
 * @param {import('mongodb').Collection|undefined} collection @param {string} name
 * @param {Array<Record<string,any>>} games @param {AbortSignal} [signal]
 * @returns {Promise<Record<string,any>>} */
async function readCommunityTimings(collection, name, games, signal) {
  if (!collection) return {};
  const targets = comparisonTargets(name, games);
  if (!targets.length) return {};
  try {
    const docs = await collection.find({ kind: "build", era: GUIDE_CURRENT_ERA, published: true,
      key: { $in: targets.map(row => row.key) } }, { projection: { _id: 0, key: 1, buildKey: 1, buildSlug: 1,
      matchup: 1, era: 1, published: 1, overall: 1, timings: 1, computedAt: 1 }, maxTimeMS: 1000, ...(signal ? { signal } : {}),
    }).limit(targets.length).toArray();
    /** @type {Record<string,any>} */ const result = {};
    for (const target of targets) {
      const doc = docs.find(row => row.key === target.key && row.buildKey === name && row.matchup === target.matchup
        && row.buildSlug === target.slug && row.era === GUIDE_CURRENT_ERA && servesPublishedCell(row));
      if (!doc) continue;
      const rows = comparableRows(target.matchup, doc.timings);
      if (!rows.length) continue;
      result[target.matchup] = { href: `/guides/${target.matchup.toLowerCase()}/${target.slug}`, era: GUIDE_CURRENT_ERA,
        computedAt: doc.computedAt instanceof Date && Number.isFinite(doc.computedAt.getTime()) ? doc.computedAt.toISOString() : null, rows };
    }
    return result;
  } catch (error) {
    if (signal?.aborted) throw error;
    return {};
  }
}

module.exports = { comparisonTargets, comparableRows, readCommunityTimings };
