"use strict";

const { BSONRegExp } = require("mongodb");
const { COMMUNITY_SEARCH_COMMENT } = require("../middleware/searchQueryPrivacy");
const { boundedPublicString } = require("./communityBuildSnapshot");

// The signed-out quick-search palette's Community builds (ADR 0069, 2026-11-01
// amendment): slim rows only, never a count, author links or build snapshot.
const COMMUNITY_QUICK_LIMIT = 8;
const COMMUNITY_QUICK_DEADLINE_MS = 300;
// The web sitemap's grammar: build-<hex>, or a legacy slug that may hold dots.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MATCHUP_RE = /^[PTZR]v[PTZR]$/;
const CONTROLS = /\p{Cc}+/gu;

/** @param {unknown} value @param {number} max @returns {string|null} */
function publicText(value, max) {
  const text = boundedPublicString(value, max)?.replace(CONTROLS, " ").trim();
  return text ? text : null;
}

/**
 * A row the web decoder accepts, or null for a malformed slug or a blank title.
 * @param {Record<string, any>} row
 * @returns {{slug: string, title: string, matchup: string|null, authorName: string|null, votes: number}|null}
 */
function quickRow(row) {
  const slug = typeof row?.slug === "string" && SLUG_RE.test(row.slug) ? row.slug : null;
  const title = publicText(row?.title, 200);
  if (!slug || !title) return null;
  return {
    slug,
    title,
    matchup: typeof row.matchup === "string" && MATCHUP_RE.test(row.matchup) ? row.matchup : null,
    authorName: publicText(row.authorName, 80),
    votes: Number.isSafeInteger(row.votes) ? row.votes : 0,
  };
}

/**
 * Published builds whose title or author name has a word starting with `query`
 * (escaped, case-insensitive), most votes first. A word starts at the beginning
 * or after any character that is not a letter or digit in any script. No index
 * serves this match: the rows examined are bounded by the published builds and the deadline.
 * Example: quickSearchCommunityBuilds(db.communityBuilds, "stargate", { limit: 8 }).
 * @param {import('mongodb').Collection} builds
 * @param {string} query already validated: 2-80 code points, no controls
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{version: 1, items: NonNullable<ReturnType<typeof quickRow>>[], hasMore: boolean}>}
 */
async function quickSearchCommunityBuilds(builds, query, opts = {}) {
  const limit = Math.min(Math.max(1, Math.trunc(Number(opts.limit) || COMMUNITY_QUICK_LIMIT)), COMMUNITY_QUICK_LIMIT);
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The server's PCRE reads this pattern exactly as written, in UTF mode. A JavaScript
  // RegExp would arrive as its `source`, which spells a line separator as \u that PCRE rejects.
  const pattern = new BSONRegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}`, "i");
  const rows = await builds.aggregate([
    { $match: { removed: false, $or: [{ title: pattern }, { authorName: pattern }] } },
    { $sort: { votes: -1, publishedAt: -1, slug: 1 } },
    // Room for rows quickRow drops, so a blank legacy title cannot hide hasMore.
    { $limit: limit * 2 + 1 },
    { $project: { _id: 0, slug: 1, title: 1, matchup: 1, authorName: 1, votes: 1 } },
  ], { maxTimeMS: COMMUNITY_QUICK_DEADLINE_MS, allowDiskUse: false, comment: COMMUNITY_SEARCH_COMMENT }).toArray();
  const valid = rows.flatMap(row => { const item = quickRow(row); return item ? [item] : []; });
  return { version: 1, items: valid.slice(0, limit), hasMore: valid.length > limit };
}

module.exports = { COMMUNITY_QUICK_LIMIT, COMMUNITY_QUICK_DEADLINE_MS, quickSearchCommunityBuilds, _internals: { quickRow } };
