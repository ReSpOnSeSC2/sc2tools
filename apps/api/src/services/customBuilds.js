"use strict";

/**
 * Custom builds service. Per-user authored builds. Stored under
 * (userId, slug) — slug is a stable client-generated id.
 *
 * NOTE: shared community-builds remain in cloud/community-builds/ —
 * this is the user's PRIVATE library, which they may publish to the
 * community DB via a separate flow.
 */
class CustomBuildsService {
  /** @param {{customBuilds: import('mongodb').Collection}} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * @param {string} userId
   * @returns {Promise<object[]>}
   */
  async list(userId) {
    return this.db.customBuilds
      .find({ userId, deletedAt: { $exists: false } }, { projection: { _id: 0 } })
      .sort({ updatedAt: -1 })
      .toArray();
  }

  /**
   * @param {string} userId
   * @param {string} slug
   */
  async get(userId, slug) {
    return this.db.customBuilds.findOne(
      { userId, slug, deletedAt: { $exists: false } },
      { projection: { _id: 0 } },
    );
  }

  /**
   * Idempotent upsert. Updates updatedAt on every write.
   *
   * @param {string} userId
   * @param {{slug: string} & Record<string, unknown>} build
   */
  async upsert(userId, build) {
    if (!build || !build.slug) throw new Error("slug required");
    const now = new Date();
    /** @type {Record<string, any>} */
    const doc = { ...build, userId, updatedAt: now };
    delete doc._id;
    delete doc.deletedAt;
    await this.db.customBuilds.updateOne(
      { userId, slug: build.slug },
      { $setOnInsert: { createdAt: now }, $set: doc, $unset: { deletedAt: "" } },
      { upsert: true },
    );
  }

  /**
   * Soft-delete: keep the document so the agent's local cache can
   * reconcile, but mark it deleted so list queries skip it.
   *
   * @param {string} userId
   * @param {string} slug
   */
  async softDelete(userId, slug) {
    await this.db.customBuilds.updateOne(
      { userId, slug },
      { $set: { deletedAt: new Date() } },
    );
  }
}

module.exports = { CustomBuildsService };
