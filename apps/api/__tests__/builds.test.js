// @ts-nocheck
"use strict";

const { BuildsService } = require("../src/services/builds");
const { StrategyPhasesService } = require("../src/services/strategyPhases");

function buildGames(handlers, opts = {}) {
  let i = 0;
  const findRows = opts.find || [];
  return {
    aggregate(pipeline) {
      const handler = handlers[i++ % handlers.length];
      return {
        toArray: () => Promise.resolve(handler(pipeline)),
      };
    },
    find() {
      // Support the dossier-extras follow-up query: find(...).sort(...).toArray().
      const cursor = {
        sort: () => cursor,
        toArray: () => Promise.resolve(findRows),
      };
      return cursor;
    },
  };
}

describe("services/builds", () => {
  test("list returns all builds with computed winRate", async () => {
    const games = buildGames([
      () => [
        { name: "P - Stargate", wins: 4, losses: 2, total: 6, lastPlayed: new Date(), winRate: 4 / 6 },
        { name: "P - Glaives", wins: 1, losses: 3, total: 4, lastPlayed: new Date(), winRate: 0.25 },
      ],
    ]);
    const svc = new BuildsService({ games });
    const out = await svc.list("u1", {});
    expect(out).toHaveLength(2);
    expect(out[0].winRate).toBeCloseTo(4 / 6);
  });

  test("detail returns null when no games match the build", async () => {
    const games = buildGames([
      () => [{ totals: [], byMatchup: [], byMap: [], byStrategy: [], recent: [] }],
    ]);
    const svc = new BuildsService({ games });
    const out = await svc.detail("u1", "P - Stargate", {});
    expect(out).toBeNull();
  });

  test("detail collapses every facet into the legacy shape", async () => {
    const games = buildGames(
      [
        () => [
          {
            totals: [{ wins: 5, losses: 5, total: 10, lastPlayed: new Date() }],
            byMatchup: [{ name: "vs Z", wins: 3, losses: 2, total: 5 }],
            byMap: [{ name: "Goldenaura", wins: 2, losses: 1, total: 3 }],
            byStrategy: [{ name: "Cheese", wins: 1, losses: 2, total: 3 }],
            recent: [{ gameId: "g1", date: new Date(), map: "Goldenaura", opponent: "Foo", opp_race: "Z", opp_strategy: "Cheese", result: "Victory" }],
          },
        ],
      ],
      { find: [] },
    );
    const svc = new BuildsService({ games });
    const out = /** @type {any} */ (await svc.detail("u1", "P - Stargate", {}));
    expect(out.name).toBe("P - Stargate");
    expect(out.totals.winRate).toBe(0.5);
    expect(out.byMatchup[0].winRate).toBe(0.6);
    expect(out.recent).toHaveLength(1);
    expect(out).toHaveProperty("topStrategies");
    expect(out).toHaveProperty("predictedStrategies");
    expect(out).toHaveProperty("medianTimings");
    expect(out).toHaveProperty("macro");
    expect(out.macro.gamesWithScore).toBe(0);
  });

  test("detail derives DNA + macro extras from enriched game docs", async () => {
    const baseDate = new Date("2026-04-01T00:00:00Z");
    const enriched = [
      {
        gameId: "g1",
        date: baseDate,
        result: "Victory",
        map: "Goldenaura",
        myRace: "P",
        myBuild: "P - Stargate",
        durationSec: 720,
        macroScore: 78,
        apm: 220,
        spq: 88,
        buildLog: ["[1:30] Gateway", "[2:00] CyberneticsCore"],
        oppBuildLog: ["[2:30] SpawningPool"],
        opponent: { displayName: "Foo", race: "Z", strategy: "Pool first" },
      },
      {
        gameId: "g2",
        date: new Date("2026-03-30T00:00:00Z"),
        result: "Defeat",
        map: "Site Delta",
        myRace: "P",
        myBuild: "P - Stargate",
        durationSec: 540,
        macroScore: 55,
        apm: 180,
        spq: 70,
        buildLog: ["[1:45] Gateway"],
        oppBuildLog: ["[2:50] SpawningPool"],
        opponent: { displayName: "Bar", race: "Z", strategy: "Roach allin" },
      },
    ];
    const games = buildGames(
      [
        () => [
          {
            totals: [{ wins: 1, losses: 1, total: 2, lastPlayed: baseDate }],
            byMatchup: [{ name: "vs Z", wins: 1, losses: 1, total: 2 }],
            byMap: [],
            byStrategy: [
              { name: "Pool first", wins: 1, losses: 0, total: 1 },
              { name: "Roach allin", wins: 0, losses: 1, total: 1 },
            ],
            recent: [],
          },
        ],
      ],
      { find: enriched },
    );
    const svc = new BuildsService({ games });
    const out = /** @type {any} */ (await svc.detail("u1", "P - Stargate", {}));
    expect(out.macro.gamesWithScore).toBe(2);
    expect(out.macro.avgMacroScore).toBeCloseTo((78 + 55) / 2);
    expect(out.macro.scoreDistribution.excellent).toBe(1);
    expect(out.macro.scoreDistribution.good).toBe(1);
    expect(out.last5Games).toHaveLength(2);
    expect(out.predictedStrategies.length).toBeGreaterThan(0);
    expect(out.topStrategies.length).toBe(2);
  });

  test("oppStrategies returns sorted rows with winRate", async () => {
    const games = buildGames([
      () => [
        { name: "Cheese", wins: 1, losses: 2, total: 3, winRate: 1 / 3 },
        { name: "Macro", wins: 5, losses: 5, total: 10, winRate: 0.5 },
      ],
    ]);
    const svc = new BuildsService({ games });
    const out = await svc.oppStrategies("u1", {});
    expect(out).toHaveLength(2);
    expect(out[1].winRate).toBe(0.5);
  });
});

/**
 * Build a synthetic ``listForRulePreview`` payload for the strategy-
 * phases service. Every game has a deterministic mid-window
 * composition so the snapshot of the phase aggregator is stable
 * across runs. ``Probe`` is always present at 50+ to exercise the
 * worker-skip filter — the signature must never include it.
 *
 * ``myBuild`` is optional so the same fixture builder feeds both the
 * opponent-strategy path (``evaluate``) and the user-side build-name
 * path (``evaluateByBuildName``).
 *
 * @param {Array<{
 *   gameId: string,
 *   result: string,
 *   strategy: string,
 *   myUnitsAtMid: Record<string, number>,
 *   myBuild?: string,
 * }>} entries
 */
function makeStrategyGames(entries) {
  const duration = 600;
  return entries.map((e) => {
    const stats = [];
    for (let t = 0; t <= duration; t += 10) {
      stats.push({
        time: t,
        food_workers: Math.min(12 + t / 5, 70),
        food_used: Math.min(12 + t / 4, 180),
        army_value: Math.min(t * 8, 5000),
      });
    }
    const timeline = [];
    for (let t = 0; t <= duration; t += 30) {
      timeline.push({ time: t, my: { ...e.myUnitsAtMid }, opp: {} });
    }
    return {
      gameId: e.gameId,
      myRace: "Protoss",
      oppRace: "Zerg",
      durationSec: duration,
      result: e.result,
      myBuild: e.myBuild || null,
      opponent: { strategy: e.strategy, race: "Zerg" },
      macroBreakdown: {
        bases: [
          { name: "Nexus", born_time: 0, died_time: duration },
          { name: "Nexus", born_time: 100, died_time: duration },
        ],
        production_buildings: [
          { name: "CyberneticsCore", born_time: 80, died_time: duration },
          { name: "TwilightCouncil", born_time: 180, died_time: duration },
          { name: "RoboticsFacility", born_time: 200, died_time: duration },
        ],
        stats_events: stats,
        unit_timeline: timeline,
      },
      events: [],
      oppEvents: [],
    };
  });
}

describe("services/strategyPhases", () => {
  /**
   * Bind a synthetic ``listForRulePreview`` source onto a fresh
   * StrategyPhasesService. ``db`` is unused by the evaluate path —
   * passing an empty object is enough since the service only reaches
   * for ``this.db.games`` via ``latestGameDateMs`` (covered
   * separately).
   */
  function makeService(listedGames) {
    const perGame = {
      async listForRulePreview(_userId, _opts) {
        return listedGames;
      },
    };
    return new StrategyPhasesService({}, { perGame });
  }

  test("evaluate returns null when no games match the requested strategy", async () => {
    const svc = makeService(
      makeStrategyGames([
        {
          gameId: "g-other",
          result: "Victory",
          strategy: "Zerg - Roach allin",
          myUnitsAtMid: { Stalker: 4, Immortal: 2, Probe: 50 },
        },
      ]),
    );
    const out = await svc.evaluate("u1", "Zerg - Mass Ling");
    expect(out).toBeNull();
  });

  test("evaluate filters by opponent.strategy exact match", async () => {
    const games = makeStrategyGames([
      {
        gameId: "g-mass-ling-1",
        result: "Victory",
        strategy: "Zerg - Mass Ling",
        myUnitsAtMid: { Stalker: 4, Phoenix: 3, Immortal: 2, Probe: 60 },
      },
      {
        gameId: "g-roach",
        result: "Defeat",
        strategy: "Zerg - Roach allin",
        myUnitsAtMid: { Zealot: 6, Adept: 4, Sentry: 2, Probe: 50 },
      },
      {
        gameId: "g-mass-ling-2",
        result: "Victory",
        strategy: "Zerg - Mass Ling",
        myUnitsAtMid: { Stalker: 5, Phoenix: 2, Immortal: 1, Probe: 55 },
      },
    ]);
    const svc = makeService(games);

    const out = await svc.evaluate("u1", "Zerg - Mass Ling");
    expect(out).not.toBeNull();
    expect(out.name).toBe("Zerg - Mass Ling");
    expect(out.total).toBe(2);
    // The roach-allin game must not leak in — wrong strategy.
    const midKeys = out.perPhase.mid.signatures.map((s) => s.key);
    expect(midKeys).not.toContain("Zealot|Adept|Sentry");
    expect(midKeys).toContain("Stalker|Phoenix|Immortal");
  });

  test("evaluate also filters by buildName when the cell-scoping option is passed", async () => {
    // Same opponent strategy across three games; only two of them
    // carry the requested user-side build label. The BuildVsStrategy
    // drill-down passes ``buildName`` so the right column reports the
    // intersection — not the strategy's full marginal across every
    // build the user has played.
    const games = makeStrategyGames([
      {
        gameId: "g-stargate-mass-ling-1",
        result: "Victory",
        strategy: "Zerg - Mass Ling",
        myUnitsAtMid: { Stalker: 4, Phoenix: 3, Probe: 60 },
        myBuild: "PvZ - 3 Stargate Phoenix",
      },
      {
        gameId: "g-glaive-mass-ling",
        result: "Defeat",
        strategy: "Zerg - Mass Ling",
        myUnitsAtMid: { Zealot: 6, Adept: 4, Probe: 50 },
        myBuild: "PvZ - Glaive Adept",
      },
      {
        gameId: "g-stargate-mass-ling-2",
        result: "Victory",
        strategy: "Zerg - Mass Ling",
        myUnitsAtMid: { Stalker: 5, Phoenix: 2, Probe: 55 },
        myBuild: "PvZ - 3 Stargate Phoenix",
      },
    ]);
    const svc = makeService(games);

    // Unfiltered: all three Mass-Ling games qualify (legacy behavior).
    const wide = await svc.evaluate("u1", "Zerg - Mass Ling");
    expect(wide.total).toBe(3);

    // Cell-scoped: only the two Stargate Phoenix games.
    const cell = await svc.evaluate("u1", "Zerg - Mass Ling", {
      buildName: "PvZ - 3 Stargate Phoenix",
    });
    expect(cell.total).toBe(2);
    const midKeys = cell.perPhase.mid.signatures.map((s) => s.key);
    expect(midKeys).not.toContain("Zealot|Adept");
    expect(midKeys).toContain("Stalker|Phoenix");
  });

  test("evaluate forwards the global filter bar to perGame.listForRulePreview", async () => {
    // Regression guard: the StrategiesTab build × strategy comparison
    // panels were ignoring the global filter bar, so the "What you/they
    // typically do" sample counts didn't match the "All games" list
    // below them. Filters must reach ``listForRulePreview`` so the
    // matched set respects the active timeframe / race / map / region.
    let capturedOpts = null;
    const svc = new StrategyPhasesService(
      {},
      {
        perGame: {
          async listForRulePreview(_userId, opts) {
            capturedOpts = opts;
            return makeStrategyGames([
              {
                gameId: "g-x",
                result: "Victory",
                strategy: "Zerg - Mass Ling",
                myUnitsAtMid: { Stalker: 4, Phoenix: 3, Probe: 60 },
              },
            ]);
          },
        },
      },
    );
    const filters = {
      since: new Date("2026-01-01"),
      race: "P",
      map: "ghost river",
    };
    await svc.evaluate("u1", "Zerg - Mass Ling", { filters });
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts.filters).toBe(filters);
  });

  test("evaluateByBuildName forwards the global filter bar to perGame.listForRulePreview", async () => {
    // Mirror of the evaluate test for the left column's auto-classified
    // label fallback. Same fix, same regression guard.
    let capturedOpts = null;
    const svc = new StrategyPhasesService(
      {},
      {
        perGame: {
          async listForRulePreview(_userId, opts) {
            capturedOpts = opts;
            return makeStrategyGames([
              {
                gameId: "g-y",
                result: "Victory",
                strategy: "Zerg - Mass Ling",
                myUnitsAtMid: { Stalker: 4, Phoenix: 3, Probe: 60 },
                myBuild: "PvZ - 3 Stargate Phoenix",
              },
            ]);
          },
        },
      },
    );
    const filters = { since: new Date("2026-01-01"), oppRace: "Z" };
    await svc.evaluateByBuildName("u1", "PvZ - 3 Stargate Phoenix", {
      filters,
    });
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts.filters).toBe(filters);
  });

  test("evaluate returns null when the buildName filter empties the matched set", async () => {
    // Mass-Ling games exist but none carry the requested build label —
    // the cell-scoped query must 404, not return the strategy's full
    // marginal as a fallback.
    const games = makeStrategyGames([
      {
        gameId: "g-other-build",
        result: "Victory",
        strategy: "Zerg - Mass Ling",
        myUnitsAtMid: { Stalker: 4, Phoenix: 3, Probe: 60 },
        myBuild: "PvZ - Glaive Adept",
      },
    ]);
    const svc = makeService(games);
    const out = await svc.evaluate("u1", "Zerg - Mass Ling", {
      buildName: "PvZ - 3 Stargate Phoenix",
    });
    expect(out).toBeNull();
  });

  test("evaluate throws when perGame is unavailable", async () => {
    const svc = new StrategyPhasesService({}, { perGame: null });
    await expect(svc.evaluate("u1", "anything")).rejects.toThrow(
      "perGame_unavailable",
    );
  });

  test("evaluate returns null on empty strategy name", async () => {
    const svc = makeService([]);
    expect(await svc.evaluate("u1", "")).toBeNull();
  });

  /**
   * Snapshot the per-phase composition output for a synthetic
   * strategy bucket. Asserts the envelope is exactly what the
   * StrategiesTab phase panel needs (sampleSize, perPhase signatures
   * with sample counts, finalPhaseDistribution). The fixture is
   * hand-crafted so the snapshot is deterministic — if it shifts the
   * SPA's strategy phase panel renders differently and we want a
   * tripwire.
   */
  test("evaluate snapshot for the strategy bucket fixture", async () => {
    const games = makeStrategyGames([
      {
        gameId: "g1",
        result: "Victory",
        strategy: "Zerg - Mass Ling",
        myUnitsAtMid: { Stalker: 4, Phoenix: 3, Immortal: 2, Probe: 60 },
      },
      {
        gameId: "g2",
        result: "Victory",
        strategy: "Zerg - Mass Ling",
        myUnitsAtMid: { Stalker: 5, Phoenix: 2, Immortal: 1, Probe: 55 },
      },
      {
        gameId: "g3",
        result: "Defeat",
        strategy: "Zerg - Mass Ling",
        myUnitsAtMid: { Zealot: 6, Adept: 4, Sentry: 2, Probe: 50 },
      },
    ]);
    const svc = makeService(games);
    const out = await svc.evaluate("u1", "Zerg - Mass Ling");
    // Hide noise that's incidental to the snapshot: medianCrossings
    // and durationP95Sec depend on the synthetic stats curve, which
    // is verified by the buildCompositions tests already. The strategy
    // service's job is just to filter + delegate.
    const slim = {
      name: out.name,
      total: out.total,
      sampleSize: out.sampleSize,
      finalPhaseDistribution: out.finalPhaseDistribution,
      flags: out.flags,
      midSignatures: out.perPhase.mid.signatures.map((s) => ({
        key: s.key,
        sampleCount: s.sampleCount,
        wins: s.wins,
        losses: s.losses,
        winRate: s.winRate,
        sampleGameIds: s.sampleGameIds,
        units: s.units.map((u) => u.token),
      })),
    };
    expect(slim).toMatchSnapshot();
  });

  test("latestGameDateMs returns 0 when the user has no games", async () => {
    const db = {
      games: {
        async findOne() {
          return null;
        },
      },
    };
    const svc = new StrategyPhasesService(db, { perGame: {} });
    expect(await svc.latestGameDateMs("u1")).toBe(0);
  });

  test("latestGameDateMs returns the Date in ms", async () => {
    const stamp = new Date("2026-05-10T00:00:00Z");
    const db = {
      games: {
        async findOne() {
          return { date: stamp };
        },
      },
    };
    const svc = new StrategyPhasesService(db, { perGame: {} });
    expect(await svc.latestGameDateMs("u1")).toBe(stamp.getTime());
  });

  // ----- evaluateByBuildName ---------------------------------------
  // The user-side fallback that powers the left column of the
  // StrategiesTab build × strategy drill-down when no saved custom
  // build matches the agent's auto-classified label.

  test("evaluateByBuildName returns null when no games carry the label", async () => {
    const svc = makeService(
      makeStrategyGames([
        {
          gameId: "g-other",
          result: "Victory",
          strategy: "Zerg - Mass Ling",
          myUnitsAtMid: { Stalker: 4, Phoenix: 3, Probe: 50 },
          myBuild: "PvZ - Different Build",
        },
      ]),
    );
    const out = await svc.evaluateByBuildName("u1", "PvZ - 3 Stargate Phoenix");
    expect(out).toBeNull();
  });

  test("evaluateByBuildName filters by myBuild exact match", async () => {
    const games = makeStrategyGames([
      {
        gameId: "g-stargate-1",
        result: "Victory",
        strategy: "Zerg - Mass Ling",
        myUnitsAtMid: { Phoenix: 5, Stalker: 3, Probe: 60 },
        myBuild: "PvZ - 3 Stargate Phoenix",
      },
      {
        gameId: "g-other-build",
        result: "Defeat",
        strategy: "Zerg - Mass Ling",
        myUnitsAtMid: { Zealot: 6, Sentry: 2, Probe: 50 },
        myBuild: "PvZ - Glaive Adept",
      },
      {
        gameId: "g-stargate-2",
        result: "Victory",
        strategy: "Zerg - Roach allin",
        myUnitsAtMid: { Phoenix: 4, Stalker: 4, Probe: 55 },
        myBuild: "PvZ - 3 Stargate Phoenix",
      },
    ]);
    const svc = makeService(games);
    const out = await svc.evaluateByBuildName(
      "u1",
      "PvZ - 3 Stargate Phoenix",
    );
    expect(out).not.toBeNull();
    expect(out.name).toBe("PvZ - 3 Stargate Phoenix");
    expect(out.total).toBe(2);
    expect(out.perspective).toBe("you");
    // Glaive Adept game must not leak in.
    const midKeys = out.perPhase.mid.signatures.map((s) => s.key);
    expect(midKeys).toContain("Phoenix|Stalker");
    expect(midKeys).not.toContain("Zealot|Sentry");
  });

  test("evaluateByBuildName narrows to the build × strategy cell when strategyName is passed", async () => {
    // Two builds × two strategies. The drill-down passes both so the
    // left column describes exactly one cell — the same N games the
    // matrix reported, not the build's full marginal across opponents.
    const games = makeStrategyGames([
      {
        gameId: "g-stargate-mass-ling",
        result: "Victory",
        strategy: "Zerg - Mass Ling",
        myUnitsAtMid: { Phoenix: 5, Stalker: 3, Probe: 60 },
        myBuild: "PvZ - 3 Stargate Phoenix",
      },
      {
        gameId: "g-stargate-roach",
        result: "Defeat",
        strategy: "Zerg - Roach allin",
        myUnitsAtMid: { Phoenix: 3, Stalker: 5, Probe: 55 },
        myBuild: "PvZ - 3 Stargate Phoenix",
      },
      {
        gameId: "g-glaive-mass-ling",
        result: "Victory",
        strategy: "Zerg - Mass Ling",
        myUnitsAtMid: { Adept: 8, Zealot: 4, Probe: 50 },
        myBuild: "PvZ - Glaive Adept",
      },
    ]);
    const svc = makeService(games);

    // Build's full marginal — two Stargate Phoenix games.
    const wide = await svc.evaluateByBuildName(
      "u1",
      "PvZ - 3 Stargate Phoenix",
    );
    expect(wide.total).toBe(2);

    // Cell-scoped — only the one game in the (Stargate Phoenix × Mass
    // Ling) intersection.
    const cell = await svc.evaluateByBuildName(
      "u1",
      "PvZ - 3 Stargate Phoenix",
      { strategyName: "Zerg - Mass Ling" },
    );
    expect(cell.total).toBe(1);
    const midKeys = cell.perPhase.mid.signatures.map((s) => s.key);
    expect(midKeys).toContain("Phoenix|Stalker");
    expect(midKeys).not.toContain("Adept|Zealot");
  });

  test("evaluateByBuildName returns null when the strategyName filter empties the matched set", async () => {
    const games = makeStrategyGames([
      {
        gameId: "g-stargate-roach-only",
        result: "Victory",
        strategy: "Zerg - Roach allin",
        myUnitsAtMid: { Phoenix: 5, Stalker: 3, Probe: 60 },
        myBuild: "PvZ - 3 Stargate Phoenix",
      },
    ]);
    const svc = makeService(games);
    const out = await svc.evaluateByBuildName(
      "u1",
      "PvZ - 3 Stargate Phoenix",
      { strategyName: "Zerg - Mass Ling" },
    );
    expect(out).toBeNull();
  });

  test("evaluateByBuildName throws when perGame is unavailable", async () => {
    const svc = new StrategyPhasesService({}, { perGame: null });
    await expect(
      svc.evaluateByBuildName("u1", "PvZ - 3 Stargate Phoenix"),
    ).rejects.toThrow("perGame_unavailable");
  });

  test("evaluateByBuildName returns null on empty build name", async () => {
    const svc = makeService([]);
    expect(await svc.evaluateByBuildName("u1", "")).toBeNull();
  });

  // ----- push-down predicate ---------------------------------------
  // Regression guard for "265 games in the BvS cell, only 13 in the
  // comparison header." StrategyPhasesService must hand the build /
  // strategy axes to ``listForRulePreview`` as a Mongo-level ``match``
  // filter so the recency cap caps matching games — not the user's
  // full recent window of which a fraction happens to qualify.

  test("evaluate pushes opponent.strategy into the perGame match filter", async () => {
    let captured = null;
    const perGame = {
      async listForRulePreview(_userId, opts) {
        captured = opts || {};
        return makeStrategyGames([
          {
            gameId: "g-mass-ling-1",
            result: "Victory",
            strategy: "Zerg - Mass Ling",
            myUnitsAtMid: { Stalker: 4, Phoenix: 3, Probe: 60 },
          },
        ]);
      },
    };
    const svc = new StrategyPhasesService({}, { perGame });
    const out = await svc.evaluate("u1", "Zerg - Mass Ling");
    expect(out).not.toBeNull();
    expect(captured && captured.match).toEqual({
      "opponent.strategy": "Zerg - Mass Ling",
    });
    // No buildName — the build axis stays out of the predicate.
    expect(captured.match.myBuild).toBeUndefined();
  });

  test("evaluate adds myBuild to the match filter when buildName is provided", async () => {
    let captured = null;
    const perGame = {
      async listForRulePreview(_userId, opts) {
        captured = opts || {};
        return makeStrategyGames([
          {
            gameId: "g-stargate-mass-ling",
            result: "Victory",
            strategy: "Zerg - Mass Ling",
            myUnitsAtMid: { Phoenix: 5, Stalker: 3, Probe: 60 },
            myBuild: "PvZ - 3 Stargate Phoenix",
          },
        ]);
      },
    };
    const svc = new StrategyPhasesService({}, { perGame });
    await svc.evaluate("u1", "Zerg - Mass Ling", {
      buildName: "PvZ - 3 Stargate Phoenix",
    });
    expect(captured.match).toEqual({
      "opponent.strategy": "Zerg - Mass Ling",
      myBuild: "PvZ - 3 Stargate Phoenix",
    });
  });

  test("evaluateByBuildName pushes myBuild (and strategy when supplied) into the match filter", async () => {
    let captured = null;
    const perGame = {
      async listForRulePreview(_userId, opts) {
        captured = opts || {};
        return makeStrategyGames([
          {
            gameId: "g-stargate-mass-ling",
            result: "Victory",
            strategy: "Zerg - Mass Ling",
            myUnitsAtMid: { Phoenix: 5, Stalker: 3, Probe: 60 },
            myBuild: "PvZ - 3 Stargate Phoenix",
          },
        ]);
      },
    };
    const svc = new StrategyPhasesService({}, { perGame });
    await svc.evaluateByBuildName("u1", "PvZ - 3 Stargate Phoenix");
    expect(captured.match).toEqual({ myBuild: "PvZ - 3 Stargate Phoenix" });

    captured = null;
    await svc.evaluateByBuildName("u1", "PvZ - 3 Stargate Phoenix", {
      strategyName: "Zerg - Mass Ling",
    });
    expect(captured.match).toEqual({
      myBuild: "PvZ - 3 Stargate Phoenix",
      "opponent.strategy": "Zerg - Mass Ling",
    });
  });
});
