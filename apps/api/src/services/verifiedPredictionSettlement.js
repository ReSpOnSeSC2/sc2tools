"use strict";

/** Durable per-token lane, with one scalar receipt per viewer. A later lane
 * cannot start until every award in the preceding lane was acknowledged. */
class VerifiedPredictionSettlement {
  /** @param {{predictions:import('mongodb').Collection,viewers:import('mongodb').Collection,studio:import('./multichatStudio').MultichatStudioService,now:()=>number,points:number,tally:(p:any)=>any,topOracles:(token:string)=>Promise<any[]>,emit:(token:string,msg:any)=>void}} deps */
  constructor(deps) { this.deps = deps; }

  /** @param {string} token @param {{gameKey?:string,result:'win'|'loss'}} game */
  async settle(token, game) {
    const { predictions } = this.deps;
    const exact = game.gameKey ? await predictions.findOne({ token, gameKey: game.gameKey }) : null;
    if (exact?.settled && (exact.resolution !== "verified" || exact.notifiedAt)) return;
    const target = exact ?? await predictions.findOne({ token, settled: false }, { sort: { openedAt: -1 } });
    if (!target) return;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let state = await this.deps.studio.ensureCanonical(token);
      if (!state.oraclePending) {
        const current = await predictions.findOne({ _id: target._id });
        if (!current || (current.settled && (current.resolution !== "verified" || current.notifiedAt))) return;
        state = await this.deps.studio.col.findOneAndUpdate(
          { studioKey: token, oraclePending: { $exists: false } },
          [{ $set: { oracleSequence: { $add: [{ $ifNull: ["$oracleSequence", 0] }, 1] }, oraclePending: { $literal: { gameKey: current.gameKey, result: game.result } } } }],
          { returnDocument: "after" },
        );
        if (!state) continue;
      }
      await this.drain(token, state);
      if (state.oraclePending.gameKey === target.gameKey) return;
    }
    throw Object.assign(new Error("verified settlement lane busy"), { code: "oracle_settlement_busy", status: 503 });
  }

  /** Recovery on the existing summary read, including after process restart.
   * @param {string} token */
  async resume(token) {
    const state = await this.deps.studio._findDocument(token, { projection: { oraclePending: 1, oracleSequence: 1 } });
    if (state?.oraclePending) await this.drain(token, state);
  }

  /** @param {string} token @param {any} state */
  async drain(token, state) {
    const { predictions, now, tally, studio, emit, topOracles } = this.deps;
    const sequence = state.oracleSequence, job = state.oraclePending;
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !job || !["win", "loss"].includes(job.result)) throw new Error("invalid oracle settlement lane");
    let doc = await predictions.findOneAndUpdate({ token, gameKey: job.gameKey, settled: false }, {
      $set: { settled: true, resolution: "verified", settlementState: "pending", settlementSequence: sequence, result: job.result, settledAt: new Date(now()) },
    }, { returnDocument: "after" });
    doc ??= await predictions.findOne({ token, gameKey: job.gameKey });
    if (doc?.resolution === "verified" && doc.settlementSequence === sequence) {
      const picks = Object.values(doc.picks ?? {});
      const totals = tally(doc.picks ?? {});
      if (doc.settlementState !== "complete") {
        for (const pick of picks) await this.award(token, sequence, pick, job.result);
        await predictions.updateOne({ _id: doc._id, settlementSequence: sequence }, { $set: { settlementState: "complete", tally: totals } });
      }
      if (!doc.notifiedAt) {
        const leaders = await topOracles(token);
        emit(token, { type: "prediction-settled", gameKey: job.gameKey, result: job.result, tally: totals,
          correctCount: picks.filter(p => p.pick === job.result).length, pointsEach: this.deps.points, topOracles: leaders });
        await predictions.updateOne({ _id: doc._id, settlementSequence: sequence }, { $set: { notifiedAt: new Date(now()) } });
      }
    } else if (doc?.resolution === "verified" && doc.settlementState !== "complete") {
      // A mismatching incomplete receipt cannot be silently skipped.
      throw new Error("oracle settlement receipt mismatch");
    }
    await studio.col.updateOne({ studioKey: token, oracleSequence: sequence, "oraclePending.gameKey": job.gameKey }, { $unset: { oraclePending: "" } });
  }

  /** Atomic score + scalar receipt. Concurrent resumes and late older workers
   * cannot double award, even after the next lane has completed.
   * @param {string} token @param {number} sequence @param {any} pick @param {string} result */
  async award(token, sequence, pick, result) {
    const fresh = { $lt: [{ $ifNull: ["$oracle.awardSequence", 0] }, sequence] };
    const correct = pick.pick === result;
    const update = [{ $set: {
      oracle: { $cond: [fresh, {
        total: { $add: [{ $ifNull: ["$oracle.total", 0] }, 1] },
        correct: { $add: [{ $ifNull: ["$oracle.correct", 0] }, correct ? 1 : 0] },
        score: { $add: [{ $ifNull: ["$oracle.score", 0] }, correct ? this.deps.points : 0] },
        awardSequence: sequence,
      }, "$oracle"] },
      displayName: { $cond: [fresh, { $literal: pick.user }, "$displayName"] },
      platform: { $cond: [fresh, { $literal: pick.platform }, "$platform"] },
      lastSeenAt: { $cond: [fresh, new Date(this.deps.now()), "$lastSeenAt"] },
      xp: { $ifNull: ["$xp", 0] }, messages: { $ifNull: ["$messages", 0] }, events: { $ifNull: ["$events", 0] },
    } }];
    const filter = { token, userKey: `${pick.platform}:${String(pick.user).toLowerCase()}` };
    try { await this.deps.viewers.updateOne(filter, update, { upsert: true }); }
    catch (error) {
      if (/** @type {any} */ (error)?.code !== 11000) throw error;
      // Concurrent first-ever awards can race the existing unique viewer key.
      await this.deps.viewers.updateOne(filter, update);
    }
  }
}
module.exports = { VerifiedPredictionSettlement };
