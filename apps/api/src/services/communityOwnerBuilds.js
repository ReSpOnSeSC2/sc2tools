"use strict";

/** @param {string|Record<string, unknown>} field @param {number} max */
const text = (field, max) => ({ $substrCP: [{ $convert: { input: field, to: "string", onError: "", onNull: "" } }, 0, max] });

/**
 * One bounded, owner-only allowlist. Source slugs and vote counts must never
 * be reused as a public serializer; voter identities never leave Mongo.
 * @param {any} db
 * @param {string} userId
 * @param {(slugs: string[]) => Promise<Array<{publicSlug:string,total:number,wins:number,losses:number}>>} loadStats
 */
async function listOwnerBuilds(db, userId, loadStats) {
  const rows = await db.communityBuilds.aggregate([
    { $match: { ownerUserId: userId } },
    { $sort: { updatedAt: -1, publishedAt: -1, slug: 1 } },
    { $limit: 200 },
    { $project: {
      _id: 0, slug: text("$slug", 80), title: text("$title", 120), matchup: text("$matchup", 10), votes: 1,
      upCount: { $cond: [{ $isArray: "$upvotes" }, { $size: "$upvotes" }, 0] },
      downCount: { $cond: [{ $isArray: "$downvotes" }, { $size: "$downvotes" }, 0] },
      publishedAt: 1, updatedAt: 1, removed: { $eq: ["$removed", true] },
      publishAnonymously: { $or: [{ $eq: ["$publishAnonymously", true] }, { $eq: [text("$authorName", 80), ""] }] },
      sourceSlug: text({ $ifNull: ["$sourceSlug", "$build.slug"] }, 80),
      // Distinguish the creator taking a listing down from a moderation action.
      // This boolean reveals no moderator identity to the owner.
      removedByModerator: { $and: [{ $eq: ["$removed", true] }, { $ne: [{ $ifNull: ["$removedBy", userId] }, userId] }] },
    } },
  ]).toArray();
  const stats = await loadStats(rows.map((/** @type {any} */ row) => String(row.slug)));
  const counts = new Map(stats.map((row) => [row.publicSlug, row]));
  return rows.map((/** @type {any} */ row) => ({
    ...row, votes: Number.isFinite(row.votes) ? row.votes : 0,
    total: counts.get(row.slug)?.total ?? 0, wins: counts.get(row.slug)?.wins ?? 0, losses: counts.get(row.slug)?.losses ?? 0,
  }));
}

module.exports = { listOwnerBuilds };
