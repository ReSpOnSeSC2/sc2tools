"use strict";

const { roundToTick, raceLetter } = require("./snapshotCohort");
const { buildTickResponse } = require("./snapshotTechPath");
const { indexUnitTimeline } = require("./snapshotCentroids");

/**
 * SnapshotGameComposer — orchestrates the per-tick computation
 * for a single game's drilldown response. Pulls together:
 *
 *   - cohort bands (from snapshotCohort.aggregateBands)
 *   - tick scores (from snapshotCompare.compareGameToCohort)
 *   - tech-path block per tick (from snapshotTechPath)
 *   - composition matchup block at anchor ticks (from
 *     snapshotMatchupMatrix)
 *   - composition delta + insights (existing services)
 *
 * Extracted from the route so the route stays lean and the
 * orchestration logic is unit-testable without an Express harness.
 */

const ANCHOR_TICKS = [180, 300, 420, 600, 780, 960];

class SnapshotGameComposer {
  /**
   * @param {{
   *   snapshotCohort: import('./snapshotCohort').SnapshotCohortService,
   *   snapshotCompare: import('./snapshotCompare').SnapshotCompareService,
   *   snapshotCentroids: import('./snapshotCentroids').SnapshotCentroidsService,
   *   snapshotInsights: import('./snapshotInsights').SnapshotInsightsService,
   *   snapshotTechPath: import('./snapshotTechPath').SnapshotTechPathService,
   *   snapshotMatchupMatrix: import('./snapshotMatchupMatrix').SnapshotMatchupMatrixService,
   * }} services
   */
  constructor(services) {
    Object.assign(this, services);
  }

  /**
   * Compose the full game-snapshot response. Takes the focal
   * game + the pre-resolved cohort + the cached bands and merges
   * tech-path + composition-matchup augmentations into the
   * per-tick rows.
   *
   * @param {{
   *   focal: { game: object, detail: object },
   *   cohortGames: Array<object>,
   *   detailsByGameId: Map<string, object>,
   *   bandsTicks: Array<any>,
   *   weightsOverride?: object,
   * }} input
   */
  composeGameResponse(input) {
    const { focal, cohortGames, detailsByGameId, bandsTicks, weightsOverride } = input;
    const myRace = raceLetter(focal.game.myRace);
    const oppRace = raceLetter(focal.game.opponent?.race);

    // Tech-path block + extras (per tick).
    const focalDecisionFirst = this.snapshotTechPath.parseDecisionBuildings(
      focal.detail.buildLog,
      myRace,
    );
    const techByTick = this._techPathByTick(focalDecisionFirst, focal, cohortGames, detailsByGameId);

    // Matchup matrix at anchor ticks.
    const matchupByTick = this._matchupByAnchorTicks(focal, cohortGames, detailsByGameId);

    // ExtraScores assembled per tick from the path winrate +
    // composition matchup verdict.
    const extraScoresByTick = buildExtraScores(techByTick, matchupByTick);

    // Compare with phase-aware weights.
    const tickScores = this.snapshotCompare.compareGameToCohort(
      focal.detail,
      { ticks: bandsTicks },
      { myRace: focal.game.myRace, oppRace: focal.game.opponent?.race, extraScoresByTick, weightsOverride },
    );

    // Composition deltas for the focal game vs cohort centroids
    // — reuses existing snapshotCentroids logic.
    const centroids = this.snapshotCentroids.computeCentroids(cohortGames, detailsByGameId);
    const { my: myUnits, opp: oppUnits } = indexUnitTimeline(focal.detail.macroBreakdown?.unit_timeline);
    const compositionByTick = this.snapshotCentroids.computeDeltas(myUnits, oppUnits, centroids);

    // Per-tick merge.
    const ticksOut = tickScores.map((row) => ({
      ...row,
      techPath: techByTick.get(row.t) || null,
      compositionMatchup: matchupByTick.get(row.t) || null,
      compositionDelta: compositionDeltaFor(compositionByTick, row.t),
    }));

    // Insights.
    const inflection = this.snapshotInsights.detectInflection(tickScores);
    const timingMisses = this.snapshotInsights.detectTimingMisses(
      cohortGames,
      detailsByGameId,
      focal.detail.macroBreakdown?.unit_timeline,
    );
    const coachingTags = this.snapshotInsights.deriveCoachingTags(tickScores);

    return {
      ticks: ticksOut,
      insights: {
        inflectionTick: inflection.inflectionTick,
        primaryMetric: inflection.primaryMetric,
        secondaryMetric: inflection.secondaryMetric,
        timingMisses,
        coachingTags,
      },
    };
  }

  /**
   * @private
   * @returns {Map<number, any>}
   */
  _techPathByTick(focalDecisionFirst, focal, cohortGames, detailsByGameId) {
    /** @type {Map<number, any>} */
    const out = new Map();
    const myRace = raceLetter(focal.game.myRace);
    for (let t = 0; t <= 1200; t += 30) {
      const present = [];
      for (const [name, atSec] of focalDecisionFirst) {
        if (atSec <= t) present.push(name);
      }
      if (present.length === 0 && t < 240) continue;
      const block = buildTickResponse(
        this.snapshotTechPath,
        { buildLog: focal.detail.buildLog, race: myRace },
        cohortGames,
        detailsByGameId,
        t,
      );
      out.set(t, block);
    }
    return out;
  }

  /**
   * @private
   * Anchor-tick matrix evaluation. Per-tick verdicts would balloon
   * the payload; we evaluate at the published anchor ticks and the
   * UI hits ``GET /v1/snapshots/matrix`` for arbitrary ticks.
   *
   * @returns {Map<number, any>}
   */
  _matchupByAnchorTicks(focal, cohortGames, detailsByGameId) {
    /** @type {Map<number, any>} */
    const out = new Map();
    const myRace = raceLetter(focal.game.myRace);
    const oppRace = raceLetter(focal.game.opponent?.race);
    const tlIndex = indexUnitTimeline(focal.detail.macroBreakdown?.unit_timeline);
    for (const tick of ANCHOR_TICKS) {
      const matrix = this.snapshotMatchupMatrix.buildMatrix(cohortGames, detailsByGameId, tick);
      if (matrix.myClusters.length === 0) continue;
      const myUnits = tlIndex.my.get(tick) || {};
      const oppUnits = tlIndex.opp.get(tick) || {};
      const resolved = this.snapshotMatchupMatrix.resolveFocal(
        { units: myUnits, race: myRace },
        { units: oppUnits, race: oppRace },
        matrix,
      );
      if (resolved) out.set(tick, resolved);
    }
    return out;
  }
}

function buildExtraScores(techByTick, matchupByTick) {
  /** @type {Map<number, { my: Record<string, number>, opp: Record<string, number> }>} */
  const out = new Map();
  for (const [t, tech] of techByTick) {
    addExtra(out, t, "my", "tech_path_winrate", tech.score);
    addExtra(out, t, "my", "tech_tier_reached", techTierScore(tech.buildingsInPath.length));
  }
  for (const [t, m] of matchupByTick) {
    addExtra(out, t, "my", "composition_matchup", matchupScore(m.winRate));
  }
  return out;
}

function addExtra(out, t, side, key, value) {
  if (!Number.isFinite(value)) return;
  let row = out.get(t);
  if (!row) {
    row = { my: {}, opp: {} };
    out.set(t, row);
  }
  row[side][key] = value;
}

function techTierScore(buildingCount) {
  if (buildingCount === 0) return -2;
  if (buildingCount === 1) return -1;
  if (buildingCount === 2) return 0;
  if (buildingCount === 3) return 1;
  return 2;
}

function matchupScore(winRate) {
  if (!Number.isFinite(winRate)) return 0;
  const centered = winRate - 0.5;
  const scaled = centered / 0.1;
  if (scaled > 2) return 2;
  if (scaled < -2) return -2;
  return scaled;
}

function compositionDeltaFor(compositionByTick, tickSec) {
  const comp = compositionByTick.get(tickSec);
  if (!comp) return null;
  return {
    my: comp.my,
    opp: comp.opp,
    mySimilarity: comp.mySimilarity,
    oppSimilarity: comp.oppSimilarity,
  };
}

module.exports = {
  SnapshotGameComposer,
  ANCHOR_TICKS,
  buildExtraScores,
  matchupScore,
  techTierScore,
};
