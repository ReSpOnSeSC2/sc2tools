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
 *     can be up to a day stale. Replays also have to still qualify for the
 *     guide and have a stored file. Rendered web pages may keep a cached copy for up to
 *     GUIDE_REVALIDATE_SEC (6 h, apps/web/lib/guides/api.ts). GDPR deletes
 *     and history wipes also pull the user's examples from guide_stats
 *     (services/gdpr.js ``_scrubGuideExamples``).
 *
 * The replay links use opaque references. Raw game IDs and opponent names
 * are kept out of the guide response.
 */

const { displayName } = require("../config/guideSlugs");
const { GUIDE_EXAMPLES_MAX } = require("../config/guides");
const { publicReplayObjectId } = require("../util/publicReplayReference");
const { publicDisplayName, exampleGamesMatch, EXAMPLE_FIELDS, toExample } = require("./guideStatsExamples");

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
 * @typedef {import('./guideStatsExamples').GuideExample & {href: string}} GuideExampleLink
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
  return list.filter((ex) => ex && typeof ex.handle === "string" && ex.handle.length <= 64
    && SHARE_SLUG_RE.test(ex.handle) && ex.playedAt instanceof Date && typeof ex.result === "string")
    .slice(0, GUIDE_EXAMPLES_MAX);
}

/**
 * Keep the examples whose owners still share, using current replay metadata.
 *
 * @param {import('mongodb').Collection|undefined} users
 * @param {import('mongodb').Collection|undefined} games
 * @param {string} matchup
 * @param {string} buildKey
 * @param {unknown} examples the build doc's ``examples``
 * @returns {Promise<GuideExampleLink[]>}
 */
async function verifyExamples(users, games, matchup, buildKey, examples) {
  const stored = storedExamples(examples);
  if (!users || !games || stored.length === 0) return [];
  const handles = [...new Set(stored.map((ex) => ex.handle))];
  const rows = await users
    .find(
      { "replaySharing.slug": { $type: "string", $in: handles }, "replaySharing.enabled": true },
      { projection: { _id: 0, userId: 1, displayName: 1, "replaySharing.slug": 1 }, maxTimeMS: QUERY_MAX_MS },
    )
    .toArray();
  /** @type {Map<string, {userId: string, handle: string, displayName: string}>} */
  const live = new Map();
  for (const row of rows) {
    const slug = row.replaySharing && row.replaySharing.slug;
    if (typeof slug === "string" && typeof row.userId === "string") {
      live.set(slug, { userId: row.userId, handle: slug, displayName: publicDisplayName(row.displayName) });
    }
  }
  const eligible = exampleGamesMatch(matchup, [buildKey]);
  const links = await Promise.all(stored.map(async (ex) => {
    const profile = live.get(ex.handle);
    if (!profile) return null;
    const example = await resolveExample(games, ex, eligible, profile);
    return example ? {
      ...example, href: `/players/${example.handle}/replays/${example.replayRef}`,
    } : null;
  }));
  return links.filter((link) => link !== null);
}

/**
 * Old snapshots have metadata only. Resolve them through the owner/build/date
 * index while the next nightly run is pending. A match must be unambiguous.
 * @param {import('mongodb').Collection} games
 * @param {Record<string, any>} ex
 * @param {Record<string, any>} eligible
 * @param {{userId: string, handle: string, displayName: string}} profile
 */
async function resolveExample(games, ex, eligible, profile) {
  const ownerGames = { ...eligible, userId: profile.userId };
  const options = { projection: EXAMPLE_FIELDS, maxTimeMS: QUERY_MAX_MS };
  if (ex.replayRef !== undefined) {
    const _id = publicReplayObjectId(ex.replayRef);
    const game = _id ? await games.findOne({ ...ownerGames, _id }, options) : null;
    return game && toExample(game, profile);
  }
  const candidates = await games.find({
    ...ownerGames,
    date: ex.playedAt,
    result: ex.result,
    ...(typeof ex.map === "string" ? { map: ex.map } : {}),
    ...(Number.isFinite(ex.durationSec) ? {
      durationSec: { $gte: Math.max(0, ex.durationSec - 0.5), $lt: ex.durationSec + 0.5 },
    } : {}),
  }, options).limit(2).toArray();
  if (candidates.length !== 1) return null;
  const candidate = toExample(candidates[0], profile);
  return candidate && candidate.map === ex.map && candidate.durationSec === ex.durationSec ? candidate : null;
}

module.exports = { communityBuildLinks, verifyExamples, exactNameRegex };
