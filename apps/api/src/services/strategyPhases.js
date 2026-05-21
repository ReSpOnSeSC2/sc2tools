"use strict";

const { computeCompositions } = require("./buildCompositions");

const STATS_GAME_SCAN_CAP = 1000;

/**
 * StrategyPhasesService — phase-aware aggregator keyed by the
 * detected opponent strategy or the user-side build label. Mirrors
 * ``CustomBuildsService.evaluateBuildPhases`` but groups by a
 * single game field (``opponent.strategy`` for ``evaluate`` /
 * ``myBuild`` for ``evaluateByBuildName``) rather than by saved-
 * rule matches. Feeds the StrategiesTab drill-down "what this
 * matchup looks like phase-by-phase" panel on the right, and the
 * "what you typically do" fallback on the left when the user has
 * games for an agent-classified label but hasn't saved a matching
 * custom build.
 *
 * Pipeline: pull the user's recent games via ``perGame
 * .listForRulePreview`` with ``includeMacroBreakdown: true``, filter
 * by the chosen field (case-sensitive — names come from the same
 * detectors that power ``/v1/opp-strategies`` and ``/v1/builds``),
 * then hand the matched set to ``computeCompositions``. We never
 * re-run the phaseClassifier or signature logic here; matching the
 * same pipeline keeps the StrategiesTab cards identical in shape to
 * the BuildDossier phase section.
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
   * ``buildName`` further restricts the matched set to games where the
   * user's ``myBuild`` label equals the requested value. This is what
   * the BuildVsStrategyComparison drill-down passes through so the
   * right column describes the SAME game set as the cell the user
   * clicked — without it, the right column reports the strategy's
   * marginal sample across all of the user's builds (often orders of
   * magnitude larger than the cell), which made the side-by-side
   * counts incomparable.
   *
   * ``filters`` — global-filter-bar object honoured downstream so the
   * matched set respects the same time-frame / matchup / region scoping
   * as the "All games" list. Without it, the panel scanned the latest
   * 1000 games regardless of the timeframe filter and reported a
   * larger sample than the cell it was meant to describe.
   *
   * @param {string} userId
   * @param {string} strategyName
   * @param {{ perspective?: "you"|"opponent", buildName?: string, filters?: ReturnType<typeof import('../util/parseQuery').parseFilters> }} [opts]
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
    const buildName =
      opts && typeof opts.buildName === "string" && opts.buildName
        ? opts.buildName
        : null;
    const games = await this.perGame.listForRulePreview(userId, {
      limit: STATS_GAME_SCAN_CAP,
      includeMacroBreakdown: true,
      filters: opts && opts.filters,
    });
    const matched = games.filter((g) => {
      const s = g && g.opponent && g.opponent.strategy;
      if (s !== strategyName) return false;
      if (buildName && g.myBuild !== buildName) return false;
      return true;
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
   * Run the phase-aware composition pipeline against every game where
   * ``myBuild === buildName``. Returns null when no games carry that
   * label so the route layer can answer with a 404. Always scored
   * from the user's perspective — the left column of the comparison
   * view shows "what YOU typically do", and the agent only ever
   * stamps user-side build labels on the ``myBuild`` field.
   *
   * ``strategyName`` further restricts the matched set to games where
   * ``opponent.strategy`` equals the requested value. The drill-down
   * passes it through so the left column describes the SAME game set
   * as the cell the user clicked (build × strategy intersection),
   * rather than every game with that build label regardless of the
   * opponent's strategy.
   *
   * The shape mirrors ``evaluate`` so the StrategiesTab can hand
   * either payload straight to PhaseTrajectoryStrip /
   * PhaseCompositionTabs.
   *
   * @param {string} userId
   * @param {string} buildName
   * @param {{ perspective?: "you"|"opponent", strategyName?: string, filters?: ReturnType<typeof import('../util/parseQuery').parseFilters> }} [opts]
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
  async evaluateByBuildName(userId, buildName, opts = {}) {
    if (!this.perGame) throw new Error("perGame_unavailable");
    if (!buildName) return null;
    const perspective =
      opts && opts.perspective === "opponent" ? "opponent" : "you";
    const strategyName =
      opts && typeof opts.strategyName === "string" && opts.strategyName
        ? opts.strategyName
        : null;
    const games = await this.perGame.listForRulePreview(userId, {
      limit: STATS_GAME_SCAN_CAP,
      includeMacroBreakdown: true,
      filters: opts && opts.filters,
    });
    const matched = games.filter((g) => {
      if (!g || g.myBuild !== buildName) return false;
      if (strategyName) {
        const s = g.opponent && g.opponent.strategy;
        if (s !== strategyName) return false;
      }
      return true;
    });
    if (matched.length === 0) return null;
    const comps = computeCompositions(matched, { perspective });
    return {
      name: buildName,
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
