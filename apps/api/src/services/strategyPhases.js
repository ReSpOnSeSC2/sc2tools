"use strict";

const { computeCompositions } = require("./buildCompositions");

const STATS_GAME_SCAN_CAP = 1000;

/**
 * StrategyPhasesService — phase-aware aggregator keyed by the
 * detected opponent strategy. Mirrors ``CustomBuildsService
 * .evaluateBuildPhases`` but groups by ``opponent.strategy`` rather
 * than by saved-rule matches. Feeds the StrategiesTab drill-down
 * "what this matchup looks like phase-by-phase" panel.
 *
 * Pipeline: pull the user's recent games via ``perGame
 * .listForRulePreview`` with ``includeMacroBreakdown: true``, filter
 * to ``opponent.strategy === name`` (case-sensitive — names come
 * from the same detector that powers ``/v1/opp-strategies``), then
 * hand the matched set to ``computeCompositions``. We never re-run
 * the phaseClassifier or signature logic here; matching the same
 * pipeline as Prompt 4 keeps the StrategiesTab card identical in
 * shape to the BuildDossier phase section.
 */
class StrategyPhasesService {
  /**
   * @param {{games: import('mongodb').Collection}} db
   * @param {{ perGame?: import('./types').PerGameComputeService }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.perGame = opts.perGame || null;
  }

  /**
   * Run the phase-aware composition pipeline against every game where
   * the opponent ran ``strategyName``. Returns null when the strategy
   * has zero matches in the user's recent window so the route layer
   * can answer with a 404 (parallel to the build-detail flow).
   *
   * ``perspective="opponent"`` rescores the trajectory from the
   * opponent's side — feeds the right column of the
   * StrategiesTabBuildVs comparison view ("what they typically do
   * with this strategy").
   *
   * @param {string} userId
   * @param {string} strategyName
   * @param {{ perspective?: "you"|"opponent" }} [opts]
   * @returns {Promise<null | {
   *   name: string,
   *   total: number,
   *   perspective: "you"|"opponent",
   *   sampleSize: Record<string, number>,
   *   perPhase: Record<string, object>,
   *   finalPhaseDistribution: Record<string, number>,
   *   medianCrossings: object,
   *   durationP95Sec: number,
   *   flags: string[],
   * }>}
   */
  async evaluate(userId, strategyName, opts = {}) {
    if (!this.perGame) throw new Error("perGame_unavailable");
    if (!strategyName) return null;
    const perspective = opts && opts.perspective === "opponent" ? "opponent" : "you";
    const games = await this.perGame.listForRulePreview(userId, {
      limit: STATS_GAME_SCAN_CAP,
      includeMacroBreakdown: true,
    });
    const matched = games.filter((g) => {
      const s = g && g.opponent && g.opponent.strategy;
      return s === strategyName;
    });
    if (matched.length === 0) return null;
    const comps = computeCompositions(matched, { perspective });
    return {
      name: strategyName,
      total: matched.length,
      perspective,
      sampleSize: comps.sampleSize,
      perPhase: comps.perPhase,
      finalPhaseDistribution: comps.finalPhaseDistribution,
      medianCrossings: comps.medianCrossings,
      durationP95Sec: comps.durationP95Sec,
      flags: comps.flags,
    };
  }

  /**
   * Latest game date (ms since epoch) for the user, or 0 when they
   * have none. Mirrors ``CustomBuildsService.latestGameDateMs`` so
   * the route-layer cache can key on it — a freshly-ingested game
   * busts the cached payload without waiting for the TTL.
   *
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async latestGameDateMs(userId) {
    const doc = await /** @type {any} */ (this.db).games.findOne(
      { userId },
      { projection: { _id: 0, date: 1 }, sort: { date: -1 } },
    );
    if (!doc || !doc.date) return 0;
    return doc.date instanceof Date ? doc.date.getTime() : 0;
  }
}

module.exports = { StrategyPhasesService };
