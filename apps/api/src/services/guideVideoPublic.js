"use strict";

const { buildSlug } = require("../config/guideSlugs");
const { GUIDE_CURRENT_ERA } = require("../config/guides");
const { servesPublishedCell } = require("./guidesPagePayloads");

/** A title/curated match links a guide only when one catalog build matched.
 * Counter labels never silently choose a build, and ambiguity stays null.
 * @param {import('./guideVideoSelect').VideoRow} row */
function guideTarget(row) {
  const { matchup, builds } = row.match;
  if (!matchup || builds.length !== 1) return null;
  const slug = buildSlug(matchup, builds[0]);
  return slug ? { key: `build:${GUIDE_CURRENT_ERA}:${matchup}:${slug}`, slug } : null;
}

/** Publication is checked at serve time, outside the video metadata cache.
 * One bounded indexed batch uses exactly the same floor as the guide page.
 * A failed lookup removes guide links, without dropping video content.
 * @param {ReadonlyArray<import('./guideVideoSelect').VideoRow>} rows
 * @param {import('mongodb').Collection|undefined} collection
 * @returns {Promise<import('./guideVideoSelect').VideoRow[]>} */
async function withPublicGuideLinks(rows, collection) {
  const targets = new Map(rows.map(row => [row.doc.youtubeId, guideTarget(row)]));
  const keys = [...new Set([...targets.values()].flatMap(target => target ? [target.key] : []))];
  /** @type {Set<string>} */ const published = new Set();
  if (collection && keys.length) {
    try {
      const docs = await collection.find({ kind: "build", era: GUIDE_CURRENT_ERA, published: true, key: { $in: keys } }, { projection: { _id: 0, key: 1, published: 1, overall: 1 }, maxTimeMS: 5000 }).limit(keys.length).toArray();
      for (const doc of docs) if (servesPublishedCell(doc)) published.add(doc.key);
    } catch { /* Optional navigation must not turn a video read into an outage. */ }
  }
  return rows.map(row => {
    const target = targets.get(row.doc.youtubeId);
    return { ...row, video: { ...row.video, matchup: row.match.matchup, buildSlug: target && published.has(target.key) ? target.slug : null } };
  });
}

module.exports = { guideTarget, withPublicGuideLinks };
