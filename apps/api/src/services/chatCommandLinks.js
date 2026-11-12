"use strict";

const { GUIDE_CURRENT_ERA } = require("../config/guides");
const { buildSlug } = require("../config/guideSlugs");
const { servesPublishedCell } = require("./guidesPagePayloads");

const SC2TOOLS_LINK = "https://sc2tools.com";

/** @param {import('mongodb').Collection|undefined} collection */
function createBuildGuideLink(collection) {
  /** @type {Map<string,Promise<boolean>>} */
  const pending = new Map();
  return async (/** @type {string|null} */ matchup, /** @type {string} */ name) => {
    const slug = matchup && buildSlug(matchup, name);
    if (!matchup || !slug || !collection) return null;
    const key = `build:${GUIDE_CURRENT_ERA}:${matchup}:${slug}`;
    let publication = pending.get(key);
    if (!publication) {
      // Share in-flight reads for catalog entries, then recheck publication on the next reply.
      publication = (async () => {
        try {
          const doc = await collection.findOne({ key, kind: "build", era: GUIDE_CURRENT_ERA, published: true }, {
            projection: { _id: 0, published: 1, overall: 1 }, maxTimeMS: 5000,
          });
          return servesPublishedCell(doc);
        } catch { return false; }
      })().finally(() => pending.delete(key));
      pending.set(key, publication);
    }
    return await publication ? `${SC2TOOLS_LINK}/guides/${matchup.toLowerCase()}/${slug}` : null;
  };
}

module.exports = { SC2TOOLS_LINK, createBuildGuideLink };
