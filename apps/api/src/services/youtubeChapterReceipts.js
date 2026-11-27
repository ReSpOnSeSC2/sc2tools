"use strict";

const KEEP_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * One row per YouTube archive the game chapters were offered to: which video,
 * whether the write happened and why not. Never the description, a title, a
 * viewer name or a credential. A rerun for the same video replaces its row.
 */
class YoutubeChapterReceipts {
  /** @param {{collection: import('mongodb').Collection<any>, now?: () => number}} deps */
  constructor({ collection, now = Date.now }) { this.rows = collection; this.now = now; }

  async ensureIndexes() {
    await this.rows.createIndex({ userId: 1, broadcastId: 1 }, { unique: true });
    await this.rows.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  /** @param {string} userId @param {Array<{id: string, state: string, reason?: string}>} receipts */
  async record(userId, receipts) {
    const at = new Date(this.now());
    for (const receipt of receipts) {
      await this.rows.updateOne({ userId, broadcastId: receipt.id }, { $set: {
        state: receipt.state, reason: receipt.reason || null, at, expiresAt: new Date(at.getTime() + KEEP_MS),
      } }, { upsert: true });
    }
  }
}

module.exports = { YoutubeChapterReceipts };
