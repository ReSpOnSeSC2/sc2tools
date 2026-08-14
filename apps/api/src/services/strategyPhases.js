"use strict";

const {
  computeCompositions,
  prepareCompositionGame,
} = require("./buildCompositions");

const PHASE_GAME_SAMPLE_LIMIT = 100;
const PHASE_METADATA_PAGE_SIZE = 25;

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
 * Pipeline: pull the user's matching games via ``perGame
 * .listForRulePreview`` with ``includeMacroBreakdown: true``, pushing
 * the build/strategy predicate down into the Mongo find so the
 * ``STATS_GAME_SCAN_CAP`` cap applies to the matching set (not to the
 * user's full recent window). Names come from the same detectors that
 * power ``/v1/opp-strategies`` and ``/v1/builds`` — case-sensitive
 * exact match. We never re-run the phaseClassifier or signature
 * logic here; matching the same pipeline keeps the StrategiesTab
 * cards identical in shape to the BuildDossier phase section.
 *
 * Push-down rationale: the previous implementation pulled the most
 * recent ``STATS_GAME_SCAN_CAP`` games unfiltered and then narrowed
 * in JS. For a user whose total game count exceeds the cap, only a
 * fraction of their actual matching games (e.g. 13 of 265) survived
 * the recency window — and the comparison view's "13 games" header
 * disagreed with the BvS matrix's true cell count. With the filter
 * pushed into Mongo the cap is on matching games and the cohort
 * matches the matrix.
 */
class StrategyPhasesService {
  /**
   * @param {{games: import('mongodb').Collection}} db
   * @param {{ perGame?: import('./perGameCompute').PerGameComputeService }} [opts]
   *   ``perGame`` is typed against the implementation class (not the
   *   ``./types`` interface) because this service forwards the
   *   ``filters`` push-down option the interface doesn't declare yet.
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.perGame = opts.perGame || null;
  }

  /**
   * Cursor through matching replays while retaining only a compact prepared
   * phase record. The legacy bulk helper is intentionally not a fallback:
   * one replay detail may approach the request-size ceiling, so an array of
   * hundreds of hydrated rows is not a valid memory bound.
   *
   * @param {string} userId
   * @param {{
   *   perspective: "you"|"opponent",
   *   filters?: object,
   *   match: Record<string, unknown>,
   *   predicate: (game: any) => boolean,
   *   signal?: AbortSignal,
   * }} opts
   * @returns {Promise<{games: Record<string, any>[], truncated: boolean}>}
   * @private
   */
  async _preparedCohort(userId, opts) {
    if (
      !this.perGame
      || typeof this.perGame.iterateRulePreviewPages !== "function"
    ) {
      throw new Error("perGame_unavailable");
    }
    /** @type {Record<string, any>[]} */
    const games = [];
    for await (const page of this.perGame.iterateRulePreviewPages(userId, {
      limit: PHASE_GAME_SAMPLE_LIMIT + 1,
      pageSize: PHASE_METADATA_PAGE_SIZE,
      perspective: opts.perspective,
      includeMacroBreakdown: true,
      filters: opts.filters,
      match: opts.match,
      signal: opts.signal,
      metadataFilter: opts.predicate,
    })) {
      if (opts.signal?.aborted) break;
      for (const game of page.games) {
        // Production applies this predicate before detail hydration; repeat it
        // here defensively for test doubles and future iterator changes.
        if (!opts.predicate(game)) continue;
        if (games.length >= PHASE_GAME_SAMPLE_LIMIT) {
          return { games, truncated: true };
        }
        games.push({
          gameId: game.gameId || null,
          result: game.result || null,
          _phasePrepared: prepareCompositionGame(game, opts.perspective),
        });
      }
    }
    return { games, truncated: false };
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
   * @param {{ perspective?: "you"|"opponent", buildName?: string, filters?: ReturnType<typeof import('../util/parseQuery').parseFilters>, signal?: AbortSignal }} [opts]
   * @returns {Promise<null | {
   *   name: string,
   *   total: number,
   *   perspective: "you"|"opponent",
   *   sampleSize: Record<string, number>,
   *   perPhase: Record<string, object>,
   *   finalPhaseDistribution: Record<string, number>,
   *   medianCrossings: {earlyMidAt: number|null, midAt: number|null, midLateAt: number|null, lateAt: number|null},
   *   durationP95Sec: number,
   *   flags: string[],
   *   sampleLimit: number,
   *   sampleTruncated: boolean,
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
    // Push the cohort filter into the Mongo find so the scan cap caps
    // matching games — not the user's most recent ``cap`` games of
    // which only a fraction happen to be this strategy. The global
    // filter bar (timeframe / race / map / mmr / region) is forwarded
    // alongside so the panel describes the same game set as the
    // "All games" list does at the analyzer-page level.
    /** @type {Record<string, any>} */
    const match = { "opponent.strategy": strategyName };
    if (buildName) match.myBuild = buildName;
    const predicate = /** @param {any} g */ (g) => {
      const s = g && g.opponent && g.opponent.strategy;
      if (s !== strategyName) return false;
      if (buildName && g.myBuild !== buildName) return false;
      return true;
    };
    const cohort = await this._preparedCohort(userId, {
      perspective,
      filters: opts && opts.filters,
      match,
      predicate,
      signal: opts.signal,
    });
    // Defensive in-memory filter — keeps the service correct against
    // a perGame implementation that ignores ``match`` (test mocks
    // historically returned every game). In production the Mongo find
    // has already done this work, so the filter is a no-op.
    const matched = cohort.games;
    if (matched.length === 0) return null;
    const comps = computeCompositions(matched, { perspective });
    if (cohort.truncated && !comps.flags.includes("sample_truncated")) {
      comps.flags.push("sample_truncated");
    }
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
      sampleLimit: PHASE_GAME_SAMPLE_LIMIT,
      sampleTruncated: cohort.truncated,
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
   * @param {{ perspective?: "you"|"opponent", strategyName?: string, filters?: ReturnType<typeof import('../util/parseQuery').parseFilters>, signal?: AbortSignal }} [opts]
   * @returns {Promise<null | {
   *   name: string,
   *   total: number,
   *   perspective: "you"|"opponent",
   *   sampleSize: Record<string, number>,
   *   perPhase: Record<string, object>,
   *   finalPhaseDistribution: Record<string, number>,
   *   medianCrossings: {earlyMidAt: number|null, midAt: number|null, midLateAt: number|null, lateAt: number|null},
   *   durationP95Sec: number,
   *   flags: string[],
   *   sampleLimit: number,
   *   sampleTruncated: boolean,
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
    // Push the cohort filter into the Mongo find so the scan cap caps
    // matching games — not the user's most recent ``cap`` games of
    // which only a fraction happen to carry this build label. Forward
    // the global filter bar alongside so the panel honours the active
    // timeframe / race / map / mmr / region too.
    /** @type {Record<string, any>} */
    const match = { myBuild: buildName };
    if (strategyName) match["opponent.strategy"] = strategyName;
    const predicate = /** @param {any} g */ (g) => {
      if (!g || g.myBuild !== buildName) return false;
      if (strategyName) {
        const s = g.opponent && g.opponent.strategy;
        if (s !== strategyName) return false;
      }
      return true;
    };
    const cohort = await this._preparedCohort(userId, {
      perspective,
      filters: opts && opts.filters,
      match,
      predicate,
      signal: opts.signal,
    });
    // Defensive in-memory filter — see ``evaluate`` for the rationale.
    const matched = cohort.games;
    if (matched.length === 0) return null;
    const comps = computeCompositions(matched, { perspective });
    if (cohort.truncated && !comps.flags.includes("sample_truncated")) {
      comps.flags.push("sample_truncated");
    }
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
      sampleLimit: PHASE_GAME_SAMPLE_LIMIT,
      sampleTruncated: cohort.truncated,
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
      { userId, isResumedFromReplay: { $ne: true } },
      { projection: { _id: 0, date: 1 }, sort: { date: -1 } },
    );
    if (!doc || !doc.date) return 0;
    return doc.date instanceof Date ? doc.date.getTime() : 0;
  }
}

module.exports = { StrategyPhasesService };
