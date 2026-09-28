"use strict";

/**
 * Serve-time links of a published build guide that come from outside
 * guide_stats (services/guides.js calls these):
 *
 *   - ``communityBuildLinks``: published community builds whose build name
 *     or title equals the catalog name or its display name — exact after
 *     trimming and case folding, never fuzzy, so a guide only links a
 *     community build that literally says it is this build;
 *   - ``verifyExamples``: the nightly example replays re-checked against
 *     the users' CURRENT replay-sharing state, because the nightly docs
 *     can be up to a day stale. A user who stopped sharing (or deleted
 *     the account) disappears immediately; the display name is re-read.
 *
 * Both return public-safe fields only (slug/title; handle/displayName/
 * result/map/length/date) — never a userId, gameId or opponent field.
 */

const { displayName } = require("../config/guideSlugs");
const { publicDisplayName } = require("./guideStatsExamples");

/** Community-build links per guide. */
const COMMUNITY_LINKS_MAX = 3;
/** Candidate rows read per guide (highest voted first). */
const COMMUNITY_CANDIDATES_MAX = 50;
const COMMUNITY_TITLE_MAX_CHARS = 200;
const COMMUNITY_SLUG_RE = /^[A-Za-z0-9_-]{1,80}$/;
const QUERY_MAX_MS = 5000;
/** Canonical replay-sharing slug (services/users.js REPLAY_SHARE_SLUG_RE). */
const SHARE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{10}$/;
const REGEX_SPECIALS_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * @typedef {object} GuideExampleLink
 * @property {string} handle
 * @property {string} displayName
 * @property {string} result
 * @property {string|null} map
 * @property {number|null} durationSec
 * @property {Date} playedAt
 * @property {string} href "/players/<handle>/replays" (the public list)
 */

/**
 * @param {string} text
 * @returns {string} trimmed, lower-cased
 */
function foldName(text) {
  return text.trim().toLowerCase();
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeRegex(text) {
  return text.replace(REGEX_SPECIALS_RE, "\\$&");
}

/**
 * Anchored, case-insensitive, whitespace-tolerant equality regex.
 *
 * @param {string} text
 * @returns {RegExp}
 */
function exactNameRegex(text) {
  return new RegExp(`^\\s*${escapeRegex(text)}\\s*$`, "i");
}

/**
 * Published community builds of the matchup that name this build exactly.
 *
 * Example: `await communityBuildLinks(db.communityBuilds, "PvZ", "PvZ - Stargate into Glaives")`
 * → `[{ slug: "build-…", title: "Stargate into Glaives" }]`.
 *
 * @param {import('mongodb').Collection|undefined} coll ``community_builds``
 * @param {string} matchup "PvZ" form
 * @param {string} buildKey exact catalog name
 * @returns {Promise<Array<{ slug: string, title: string }>>}
 */
async function communityBuildLinks(coll, matchup, buildKey) {
  if (!coll) return [];
  const names = [...new Set([buildKey, displayName(buildKey)])];
  const wanted = new Set(names.map(foldName));
  const patterns = names.map(exactNameRegex);
  const rows = await coll
    .find(
      {
        removed: false,
        matchup,
        $or: [{ title: { $in: patterns } }, { "build.name": { $in: patterns } }],
      },
      { projection: { _id: 0, slug: 1, title: 1, "build.name": 1 }, maxTimeMS: QUERY_MAX_MS },
    )
    .sort({ votes: -1, publishedAt: -1 })
    .limit(COMMUNITY_CANDIDATES_MAX)
    .toArray();
  /** @type {Array<{ slug: string, title: string }>} */
  const out = [];
  for (const row of rows) {
    const link = exactLink(row, wanted);
    if (link) out.push(link);
  }
  return out.slice(0, COMMUNITY_LINKS_MAX);
}

/**
 * The public link of a candidate row whose title or build name matches
 * exactly (JS re-check of the Mongo regex), or null.
 *
 * @param {Record<string, any>} row
 * @param {Set<string>} wanted folded catalog / display names
 * @returns {{ slug: string, title: string }|null}
 */
function exactLink(row, wanted) {
  const title = typeof row.title === "string" ? row.title.trim().slice(0, COMMUNITY_TITLE_MAX_CHARS) : "";
  const buildName = row.build && typeof row.build.name === "string" ? row.build.name : "";
  const exact = wanted.has(foldName(title)) || wanted.has(foldName(buildName));
  const slugOk = typeof row.slug === "string" && COMMUNITY_SLUG_RE.test(row.slug);
  return exact && title && slugOk ? { slug: row.slug, title } : null;
}

/**
 * @param {unknown} list stored examples
 * @returns {Array<Record<string, any>>} well-formed stored examples
 */
function storedExamples(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((ex) => ex && typeof ex.handle === "string" && SHARE_SLUG_RE.test(ex.handle)
    && ex.playedAt instanceof Date && typeof ex.result === "string");
}

/**
 * Keep the examples whose users still share replays, with their current
 * display names.
 *
 * @param {import('mongodb').Collection|undefined} users
 * @param {unknown} examples the build doc's ``examples``
 * @returns {Promise<GuideExampleLink[]>}
 */
async function verifyExamples(users, examples) {
  const stored = storedExamples(examples);
  if (!users || stored.length === 0) return [];
  const handles = [...new Set(stored.map((ex) => ex.handle))];
  const rows = await users
    .find(
      { "replaySharing.slug": { $type: "string", $in: handles }, "replaySharing.enabled": true },
      { projection: { _id: 0, displayName: 1, "replaySharing.slug": 1 }, maxTimeMS: QUERY_MAX_MS },
    )
    .toArray();
  /** @type {Map<string, string>} */
  const live = new Map();
  for (const row of rows) {
    const slug = row.replaySharing && row.replaySharing.slug;
    if (typeof slug === "string") live.set(slug, publicDisplayName(row.displayName));
  }
  /** @type {GuideExampleLink[]} */
  const out = [];
  for (const ex of stored) {
    const name = live.get(ex.handle);
    if (name !== undefined) out.push(exampleLink(ex, name));
  }
  return out;
}

/**
 * @param {Record<string, any>} ex a well-formed stored example
 * @param {string} displayName the sharer's current public name
 * @returns {GuideExampleLink}
 */
function exampleLink(ex, displayName) {
  return {
    handle: ex.handle,
    displayName,
    result: ex.result,
    map: typeof ex.map === "string" ? ex.map : null,
    durationSec: typeof ex.durationSec === "number" && Number.isFinite(ex.durationSec) ? ex.durationSec : null,
    playedAt: ex.playedAt,
    href: `/players/${ex.handle}/replays`,
  };
}

module.exports = { communityBuildLinks, verifyExamples, exactNameRegex };
