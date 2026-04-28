"use strict";

const { httpError } = require("../util/httpError");

const UPVOTE = 1;
const DOWNVOTE = -1;

/** Voting / flagging logic. Idempotent per (clientId, buildId). */
class VotesService {
  /** @param {{ builds: import('mongodb').Collection,
   *            votes: import('mongodb').Collection,
   *            flags: import('mongodb').Collection }} db */
  constructor(db) {
    this.builds = db.builds;
    this.votes = db.votes;
    this.flags = db.flags;
  }

  /**
   * Cast or change a vote. Returns the resulting vote totals.
   *
   * @param {{ buildId: string, clientId: string, vote: number, now: number }} args
   * @returns {Promise<{ upvotes: number, downvotes: number }>}
   */
  async vote({ buildId, clientId, vote, now }) {
    if (vote !== UPVOTE && vote !== DOWNVOTE) throw httpError(400, "bad_vote");
    const build = await this.builds.findOne({ id: buildId, deletedAt: null });
    if (!build) throw httpError(404, "not_found");
    const previous = await this.votes.findOne({ clientId, buildId });
    await this.votes.updateOne(
      { clientId, buildId },
      { $set: { vote, votedAt: now } },
      { upsert: true },
    );
    const delta = computeDelta(previous?.vote, vote);
    await this.builds.updateOne({ id: buildId }, { $inc: delta, $set: { updatedAt: now } });
    const updated = await this.builds.findOne({ id: buildId });
    if (!updated) throw httpError(404, "not_found");
    return { upvotes: updated.upvotes, downvotes: updated.downvotes };
  }

  /**
   * Flag a build for moderation.
   *
   * @param {{ buildId: string, clientId: string, reason: string, now: number }} args
   * @returns {Promise<{ flagged: number }>}
   */
  async flag({ buildId, clientId, reason, now }) {
    const build = await this.builds.findOne({ id: buildId, deletedAt: null });
    if (!build) throw httpError(404, "not_found");
    const result = await this.flags.updateOne(
      { clientId, buildId },
      { $setOnInsert: { reason: reason ?? "", flaggedAt: now } },
      { upsert: true },
    );
    if (result.upsertedCount > 0) {
      await this.builds.updateOne(
        { id: buildId },
        { $inc: { flagged: 1 }, $set: { updatedAt: now } },
      );
    }
    const updated = await this.builds.findOne({ id: buildId });
    if (!updated) throw httpError(404, "not_found");
    return { flagged: updated.flagged };
  }
}

/**
 * @param {number|undefined} previousVote
 * @param {number} nextVote
 * @returns {{ upvotes: number, downvotes: number }}
 */
function computeDelta(previousVote, nextVote) {
  const delta = { upvotes: 0, downvotes: 0 };
  applyVote(delta, previousVote, -1);
  applyVote(delta, nextVote, 1);
  return delta;
}

/**
 * @param {{ upvotes: number, downvotes: number }} delta
 * @param {number|undefined} vote
 * @param {number} sign
 */
function applyVote(delta, vote, sign) {
  if (vote === UPVOTE) delta.upvotes += sign;
  else if (vote === DOWNVOTE) delta.downvotes += sign;
}

module.exports = { VotesService };
