"use strict";

/**
 * Community + public-profile entries for the web sitemap
 * (`GET /v1/community/sitemap`, via CommunityService.sitemap()).
 *
 *   builds   — every published (``removed: false``) community build:
 *              ``/community/builds/<slug>``;
 *   profiles — the opt-in public player pages ``/p/<handle>``: one per
 *              owner of a published build with a non-blank authorName
 *              (the community opt-in PublicProfileService checks). The
 *              handle IS the owner id — the same id the public build
 *              payload already shows for named authors — and anonymous
 *              publications never contribute one.
 *
 * ``lastModified`` is the newest of ``updatedAt`` / ``publishedAt``.
 * Each list is capped at COMMUNITY_SITEMAP_MAX (newest first); only slugs
 * and handles matching the public URL grammar are emitted.
 */

/** Per-list cap (the web sitemap splits at 45 000 URLs in total). */
const COMMUNITY_SITEMAP_MAX = 10000;
const QUERY_MAX_MS = 10000;
/** Community build slugs (build-<hex>; legacy slugs are shorter). */
const BUILD_SLUG_RE = /^[A-Za-z0-9_-]{1,80}$/;
/** Public profile handle grammar (services/publicProfile.js HANDLE_RE). */
const PROFILE_HANDLE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NON_BLANK_RE = /\S/;

/** @typedef {{ slug: string, lastModified: Date }} SitemapBuild */
/** @typedef {{ handle: string, lastModified: Date }} SitemapProfile */

/** Aggregation expression: the newest of updatedAt / publishedAt (dates only). */
const LAST_MODIFIED_EXPR = Object.freeze({
  $max: [
    { $cond: [{ $eq: [{ $type: "$updatedAt" }, "date"] }, "$updatedAt", null] },
    { $cond: [{ $eq: [{ $type: "$publishedAt" }, "date"] }, "$publishedAt", null] },
  ],
});

/**
 * @param {import('mongodb').Collection} coll ``community_builds``
 * @returns {Promise<SitemapBuild[]>}
 */
async function sitemapBuilds(coll) {
  const rows = await coll.aggregate([
    { $match: { removed: false } },
    { $project: { _id: 0, slug: 1, lastModified: LAST_MODIFIED_EXPR } },
    { $match: { lastModified: { $type: "date" } } },
    { $sort: { lastModified: -1, slug: 1 } },
    { $limit: COMMUNITY_SITEMAP_MAX },
  ], { maxTimeMS: QUERY_MAX_MS, allowDiskUse: true }).toArray();
  return rows
    .filter((row) => typeof row.slug === "string" && BUILD_SLUG_RE.test(row.slug))
    .map((row) => ({ slug: row.slug, lastModified: row.lastModified }));
}

/**
 * @param {import('mongodb').Collection} coll ``community_builds``
 * @returns {Promise<SitemapProfile[]>}
 */
async function sitemapProfiles(coll) {
  const rows = await coll.aggregate([
    { $match: { removed: false, authorName: { $type: "string", $regex: NON_BLANK_RE } } },
    { $group: { _id: "$ownerUserId", lastModified: { $max: LAST_MODIFIED_EXPR } } },
    { $match: { _id: { $type: "string" }, lastModified: { $type: "date" } } },
    { $sort: { lastModified: -1, _id: 1 } },
    { $limit: COMMUNITY_SITEMAP_MAX },
  ], { maxTimeMS: QUERY_MAX_MS, allowDiskUse: true }).toArray();
  return rows
    .filter((row) => PROFILE_HANDLE_RE.test(row._id))
    .map((row) => ({ handle: row._id, lastModified: row.lastModified }));
}

/**
 * Example: `await communitySitemap(db.communityBuilds)` →
 * `{ builds: [{ slug: "build-…", lastModified }], profiles: [{ handle, lastModified }] }`.
 *
 * @param {import('mongodb').Collection|undefined} coll
 * @returns {Promise<{ builds: SitemapBuild[], profiles: SitemapProfile[] }>}
 */
async function communitySitemap(coll) {
  if (!coll) return { builds: [], profiles: [] };
  const [builds, profiles] = await Promise.all([sitemapBuilds(coll), sitemapProfiles(coll)]);
  return { builds, profiles };
}

module.exports = { communitySitemap, COMMUNITY_SITEMAP_MAX };
