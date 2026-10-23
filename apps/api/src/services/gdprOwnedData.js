"use strict";

const TOKEN_COLLECTIONS = ["multichatStudio", "multichatViewers", "multichatPredictions", "multichatClipMoments", "multichatEngagementEvents"];
/** Collect owned tokens before the owning rows disappear. The studio has both
 * canonical studioKey rows and legacy token rows; purge both without touching
 * another user's token, including after an old token was revoked.
 * @param {import('../db/connect').DbContext} db @param {string} userId @param {{assert:()=>Promise<void>}} fence
 * @param {{overlayTokens?:import('./types').OverlayTokensService|null, io?:import('socket.io').Server|null}} [opts] */
async function purgeTokenData(db, userId, fence, opts = {}) {
  /** @type {Record<string,number>} */ const counts = {};
  if (!db.overlayTokens) return counts;
  /** @type {string[]} */ let tokens = [];
  const flush = async () => {
    await fence.assert();
    for (const token of tokens) {
      if (opts.overlayTokens) await opts.overlayTokens.revoke(userId, token);
      if (opts.io) opts.io.in(`overlay:${token}`).disconnectSockets(true);
    }
    for (const key of TOKEN_COLLECTIONS) {
      const collection = /** @type {any} */ (db)[key]; if (!collection) continue;
      const filter = key === "multichatStudio" ? { $or: [{ token: { $in: tokens } }, { studioKey: { $in: tokens } }] } : { token: { $in: tokens } };
      const result = await collection.deleteMany(filter); counts[key] = (counts[key] || 0) + (result.deletedCount || 0);
    }
    tokens = [];
  };
  for await (const row of db.overlayTokens.find({ userId }, { projection: { _id: 0, token: 1 } }).batchSize(100)) {
    if (typeof row.token === "string" && row.token) tokens.push(row.token);
    if (tokens.length >= 100) await flush();
  }
  if (tokens.length) await flush();
  return counts;
}
/** Remove votes from other authors' builds and recalculate their score from
 * authoritative sets in the same atomic pipeline used by vote().
 * @param {import('../db/connect').DbContext} db @param {string} userId */
async function scrubCommunityVotes(db, userId) {
  if (!db.communityBuilds) return 0;
  const result = await db.communityBuilds.updateMany({ $or: [{ upvotes: userId }, { downvotes: userId }] }, [
    { $set: { upvotes: { $setDifference: [{ $ifNull: ["$upvotes", []] }, [userId]] }, downvotes: { $setDifference: [{ $ifNull: ["$downvotes", []] }, [userId]] } } },
    { $set: { votes: { $subtract: [{ $size: "$upvotes" }, { $size: "$downvotes" }] } } },
  ]);
  return result.modifiedCount || 0;
}
module.exports = { purgeTokenData, scrubCommunityVotes, TOKEN_COLLECTIONS };
