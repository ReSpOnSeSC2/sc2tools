"use strict";

const {
  TICK_SECONDS,
  roundToTick,
  resultOf,
} = require("./snapshotCohort");
const { cosineSimilarity } = require("./snapshotCentroids");

/**
 * SnapshotNeighborsService — "you were here at 4:00, but added two
 * Stalkers by 6:00 and won." Finds the cohort games most similar
 * to the user's deck at an anchor tick AND that diverged in the
 * other direction (opposite result) by the divergence tick. This
 * is the counterfactual replay finder the trends page uses to
 * pivot from "what went wrong" to "what could have gone right".
 *
 * Similarity is cosine over the per-tick unit composition vector.
 * The anchor tick is required (we need a comparison point); the
 * divergence tick defaults to anchor + 120 s — far enough out that
 * a different decision could have manifested but close enough that
 * the divergence is still actionable.
 *
 * Counterfactual filter: only neighbors whose ``result`` differs
 * from the focus game's result participate. A loss searching for
 * "what wins from here?" wants winner neighbors; a win confirming
 * "what loses from here?" wants loser neighbors.
 */

const DEFAULT_K = 3;
const MAX_K = 10;
const DEFAULT_DIVERGENCE_GAP_SEC = 120;
const MAX_TICK_SEC = 20 * 60;

class SnapshotNeighborsService {
  /**
   * @param {{ games: import('mongodb').Collection }} db
   * @param {{
   *   gameDetails: import('./gameDetails').GameDetailsService,
   *   cohort: import('./snapshotCohort').SnapshotCohortService,
   * }} deps
   */
  constructor(db, deps) {
    this.db = db;
    this.gameDetails = deps.gameDetails;
    this.cohort = deps.cohort;
  }

  /**
   * Find the K most similar neighbors of the focus game at the
   * anchor tick whose result diverged by the divergence tick.
   *
   * @param {{
   *   userId: string,
   *   gameId: string,
   *   anchorTick: number,
   *   divergenceTick?: number,
   *   k?: number,
   * }} query
   */
  async findNeighbors(query) {
    const anchorTick = roundToTick(query.anchorTick);
    if (anchorTick === null) {
      throw badRequest("invalid_anchor_tick");
    }
    const divergenceTick = roundToTick(
      query.divergenceTick ?? anchorTick + DEFAULT_DIVERGENCE_GAP_SEC,
    );
    if (divergenceTick === null || divergenceTick <= anchorTick) {
      throw badRequest("invalid_divergence_tick");
    }
    const k = Math.max(1, Math.min(Math.floor(query.k || DEFAULT_K), MAX_K));
    const focus = await this.db.games.findOne(
      { userId: query.userId, gameId: query.gameId },
      {
        projection: {
          _id: 0,
          userId: 1,
          gameId: 1,
          result: 1,
          myRace: 1,
          myBuild: 1,
          opponent: 1,
        },
      },
    );
    if (!focus) throw notFound("focus_game_not_found");
    const cohort = await this.cohort.resolveCohort({
      userId: query.userId,
      scope: "community",
      myBuild: focus.myBuild,
      myRace: focus.myRace,
      oppRace: focus.opponent?.race,
      oppOpening: focus.opponent?.opening,
    });
    if (cohort.tooSmall) {
      return {
        anchor: { tick: anchorTick, vector: {} },
        neighbors: [],
        cohortKey: cohort.cohortKey,
        cohortTier: null,
        sampleSize: 0,
      };
    }
    const wantResult = oppositeResult(focus.result);
    const candidates = cohort.games.filter((g) => {
      if (g.userId === focus.userId && g.gameId === focus.gameId) return false;
      return resultOf(g) === wantResult;
    });
    const detailsMap = await this._loadDetails([focus, ...candidates]);
    const focusVec = vectorAt(detailsMap.get(`${focus.userId}:${focus.gameId}`), anchorTick);
    /** @type {Array<{ game: object, sim: number, diff: Record<string, number>, divResult: string|null }>} */
    const scored = [];
    for (const g of candidates) {
      const detail = detailsMap.get(`${g.userId}:${g.gameId}`);
      const vec = vectorAt(detail, anchorTick);
      const sim = cosineSimilarity(focusVec, vec);
      if (sim <= 0) continue;
      const divVec = vectorAt(detail, divergenceTick);
      const focusDivVec = vectorAt(
        detailsMap.get(`${focus.userId}:${focus.gameId}`),
        divergenceTick,
      );
      scored.push({
        game: g,
        sim,
        diff: subtractVectors(divVec, focusDivVec),
        divResult: resultOf(g),
      });
    }
    scored.sort((a, b) => b.sim - a.sim);
    const neighbors = scored.slice(0, k).map((row) => ({
      gameId: row.game.gameId,
      userId: row.game.userId,
      similarityAtAnchor: row.sim,
      result: row.divResult,
      diffAtDivergence: row.diff,
      summary: summarize(row.diff, anchorTick, divergenceTick),
    }));
    return {
      anchor: { tick: anchorTick, vector: focusVec },
      divergence: { tick: divergenceTick },
      neighbors,
      cohortKey: cohort.cohortKey,
      cohortTier: cohort.cohortTier,
      sampleSize: cohort.sampleSize,
    };
  }

  /**
   * @private
   * @param {Array<{ userId: string, gameId: string }>} games
   */
  async _loadDetails(games) {
    /** @type {Map<string, string[]>} */
    const byUser = new Map();
    for (const g of games) {
      let arr = byUser.get(g.userId);
      if (!arr) {
        arr = [];
        byUser.set(g.userId, arr);
      }
      arr.push(g.gameId);
    }
    /** @type {Map<string, object>} */
    const out = new Map();
    for (const [userId, gameIds] of byUser) {
      const map = await this.gameDetails.findMany(userId, gameIds);
      for (const [gameId, detail] of map) {
        out.set(`${userId}:${gameId}`, detail);
      }
    }
    return out;
  }
}

/**
 * Extract the user's unit-count vector at a tick from the heavy
 * detail blob. Returns an empty object when the timeline doesn't
 * cover the tick (the cosine similarity helper treats that as
 * zero-vector → 0 similarity).
 *
 * @param {object|undefined} detail
 * @param {number} tick
 */
function vectorAt(detail, tick) {
  const timeline = detail?.macroBreakdown?.unit_timeline;
  if (!Array.isArray(timeline)) return {};
  for (const frame of timeline) {
    const t = roundToTick(frame?.time ?? frame?.t);
    if (t !== tick) continue;
    const my = frame?.my;
    if (my && typeof my === "object") return my;
  }
  return {};
}

/**
 * @param {Record<string, number>} a
 * @param {Record<string, number>} b
 */
function subtractVectors(a, b) {
  /** @type {Record<string, number>} */
  const out = {};
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const av = Number(a?.[k] || 0);
    const bv = Number(b?.[k] || 0);
    const diff = av - bv;
    if (diff !== 0) out[k] = diff;
  }
  return out;
}

/**
 * @param {Record<string, number>} diff
 * @param {number} anchorTick
 * @param {number} divergenceTick
 */
function summarize(diff, anchorTick, divergenceTick) {
  const entries = Object.entries(diff)
    .filter(([, v]) => Math.abs(v) >= 1)
    .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
    .slice(0, 2);
  if (entries.length === 0) {
    return `You at ${fmtTime(anchorTick)}, similar composition at ${fmtTime(divergenceTick)}.`;
  }
  const parts = entries.map(([unit, v]) => {
    const sign = v > 0 ? "added" : "had fewer";
    const n = Math.abs(Math.round(v));
    return `${sign} ${n} ${unit}`;
  });
  return `You at ${fmtTime(anchorTick)}, but ${parts.join(" and ")} by ${fmtTime(divergenceTick)}.`;
}

/** @param {number} t */
function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** @param {string|undefined} result */
function oppositeResult(result) {
  const r = String(result || "").toLowerCase();
  if (r === "victory" || r === "win") return "loss";
  if (r === "defeat" || r === "loss") return "win";
  return "win";
}

/** @param {string} code */
function badRequest(code) {
  const err = new Error(code);
  /** @type {any} */ (err).status = 400;
  /** @type {any} */ (err).code = code;
  return err;
}

/** @param {string} code */
function notFound(code) {
  const err = new Error(code);
  /** @type {any} */ (err).status = 404;
  /** @type {any} */ (err).code = code;
  return err;
}

module.exports = {
  SnapshotNeighborsService,
  vectorAt,
  subtractVectors,
  oppositeResult,
  DEFAULT_DIVERGENCE_GAP_SEC,
  DEFAULT_K,
  MAX_K,
};
