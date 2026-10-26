"use strict";
const { validPlayerSlug, safeIso } = require("../util/publicPlayerConfig");
const LIMIT = 1000;

/** Bounded canonical addresses only; no UUID/name, archive-only user or address
 * allocation can enter the sitemap. Existing public consent is checked in DB.
 * @param {import('../db/connect').DbContext} db */
async function publicPlayerSitemap(db) {
  const [explicit, legacy] = await Promise.all([
    db.users.find({ "publicProfile.enabled": true, "replaySharing.slug": { $type: "string" } },
      { projection: { _id: 0, "replaySharing.slug": 1, "publicProfile.updatedAt": 1 }, maxTimeMS: 3000 }).limit(LIMIT).toArray(),
    db.communityBuilds.aggregate([
      { $match: { removed: false, authorName: { $type: "string", $regex: /\S/ } } },
      { $group: { _id: "$ownerUserId", lastModified: { $max: "$publishedAt" } } }, { $limit: LIMIT },
      { $lookup: { from: db.users.collectionName, localField: "_id", foreignField: "userId", as: "user",
        pipeline: [{ $project: { _id: 0, publicProfile: 1, "replaySharing.slug": 1 } }] } },
      { $unwind: "$user" }, { $match: { "user.publicProfile": { $exists: false }, "user.replaySharing.slug": { $type: "string" } } },
      { $project: { _id: 0, slug: "$user.replaySharing.slug", lastModified: 1 } },
    ], { maxTimeMS: 3000 }).toArray(),
  ]);
  const rows = new Map();
  for (const row of explicit) {
    const handle = validPlayerSlug(row.replaySharing?.slug);
    if (handle) rows.set(handle, { handle, lastModified: safeIso(row.publicProfile?.updatedAt) });
  }
  for (const row of legacy) if (validPlayerSlug(row.slug) && !rows.has(row.slug)) rows.set(row.slug, { handle: row.slug, lastModified: safeIso(row.lastModified) });
  return { items: [...rows.values()].sort((a, b) => a.handle.localeCompare(b.handle)).slice(0, LIMIT) };
}
module.exports = { publicPlayerSitemap, LIMIT };
