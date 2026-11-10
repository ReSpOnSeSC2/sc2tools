"use strict";

const { randomUUID } = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { isDuplicateKey } = require("../util/jobLock");

const GUIDE_CONTENT_REVISION_KEY = "content-revision";
const INITIAL_GUIDE_REVISION = "initial";
const REVISION_READ_MAX_MS = 5000;
const REVISION_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/**
 * One opaque public version for guide content, stored under the existing
 * guide_stats key index. It contains no note, video or editor data.
 *
 * The singleton deliberately has no computedAt: the nightly aggregate
 * deletes old statistics by that field, and must preserve this version.
 */
class GuideFreshnessService {
  /**
   * @param {Pick<import('../db/connect').DbContext, "guideStats">} db
   * @param {{ now?: () => number }} [opts]
   */
  constructor(db, opts = {}) {
    this.coll = db.guideStats;
    this.now = opts.now || Date.now;
  }

  /** @returns {Promise<string>} */
  async readRevision() {
    const doc = await this.coll.findOne(
      { key: GUIDE_CONTENT_REVISION_KEY },
      { projection: { _id: 0, revision: 1 }, maxTimeMS: REVISION_READ_MAX_MS },
    );
    return doc && typeof doc.revision === "string" && REVISION_RE.test(doc.revision)
      ? doc.revision : INITIAL_GUIDE_REVISION;
  }

  /** @returns {Promise<string>} the version published after a successful purge */
  async markChanged() {
    const revision = randomUUID();
    const filter = { key: GUIDE_CONTENT_REVISION_KEY };
    const update = {
      $set: stampVersion({
        key: GUIDE_CONTENT_REVISION_KEY,
        kind: "revision",
        revision,
        updatedAt: new Date(this.now()),
      }, COLLECTIONS.GUIDE_STATS),
      $unset: { computedAt: "" },
    };
    try {
      await this.coll.updateOne(filter, update, { upsert: true });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // Two instances can publish their first revision concurrently.
      await this.coll.updateOne(filter, update);
    }
    return revision;
  }
}

module.exports = { GuideFreshnessService, GUIDE_CONTENT_REVISION_KEY, INITIAL_GUIDE_REVISION };
