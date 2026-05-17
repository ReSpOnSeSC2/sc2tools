// @ts-nocheck
"use strict";

/**
 * OpponentsService — phase trajectory + transition Sankey envelope.
 *
 * Pins the May-2026 wiring that adds ``phases`` and ``transitions`` to
 * the opponent profile JSON envelope. Both fields feed the
 * "How games against this opponent play out" Card on the SPA's
 * opponent profile — trajectory strip + Sankey routing the games
 * through ``(col 0) vs opponent → (col 1) opp race → (col 2) opp
 * strategy → (col 3) finalPhase``.
 *
 * The 5-game fixture in this suite is hand-crafted so the classifier
 * lands the games in deterministic phases:
 *   - 4 games with the "late" macro shape (3 bases / 5 tech / climbing
 *     stats), 3 of them sharing the same opp.strategy and 1 going
 *     through a rare strategy that folds into "Other".
 *   - 1 game with the "mid" macro shape (2 bases / 2 tech / capped
 *     stats) — its finalPhase is "mid", which is the lone non-late
 *     value and folds into a col-3 "Other" sibling.
 *
 * What we pin here:
 *   - the envelope carries ``phases`` (BuildPhasePayload-shaped) and
 *     ``transitions`` (BuildTransitionsPayload-shaped), even on the
 *     empty-games path (defensive null-safety),
 *   - the phase aggregates reflect the per-game classifier output
 *     (sample size, final-phase distribution, durations),
 *   - the Sankey path follows the opponent column scheme — col 0 is a
 *     single "opponent" node labelled "vs <name>", col 1 is opp race,
 *     col 2 is opp strategy, col 3 is finalPhase. The colour kinds on
 *     each column match the values the SPA's KIND_COLORS table keys
 *     on.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");

/**
 * Macro shape that classifies into "late" by end-of-game. Mirrors the
 * helper in buildTransitions.test.js so the fixtures drive the same
 * classifier output.
 *
 * @param {{ units: Record<string, number>, duration?: number }} opts
 */
function makeMacroLate(opts) {
  const duration = opts.duration || 600;
  const bases = [
    { name: "Nexus", born_time: 0, died_time: duration },
    { name: "Nexus", born_time: 100, died_time: duration },
    { name: "Nexus", born_time: 200, died_time: duration },
  ];
  const productionBuildings = [
    { name: "CyberneticsCore", born_time: 80, died_time: duration },
    { name: "TwilightCouncil", born_time: 150, died_time: duration },
    { name: "RoboticsFacility", born_time: 200, died_time: duration },
    { name: "Stargate", born_time: 250, died_time: duration },
    { name: "RoboticsBay", born_time: 280, died_time: duration },
  ];
  const stats = [];
  for (let t = 0; t <= duration; t += 10) {
    stats.push({
      time: t,
      food_workers: Math.min(20 + t / 8, 70),
      food_used: Math.min(12 + t / 4, 180),
      army_value: Math.min(t * 12, 5000),
    });
  }
  // Spawn the late-game units only after t=360s so the T3-unit
  // floor in phaseClassifier doesn't pin the early-game score to
  // "late" from t=0. Pre-360 timeline rows carry the worker/larva
  // baseline only — same shape, just no Carrier/Brood/etc. yet.
  const earlyUnits = pickNonT3(opts.units);
  const timeline = [];
  for (let t = 0; t <= duration; t += 30) {
    const side = t < 360 ? earlyUnits : opts.units;
    timeline.push({ time: t, my: { ...side }, opp: {} });
  }
  return {
    bases,
    production_buildings: productionBuildings,
    stats_events: stats,
    unit_timeline: timeline,
  };
}

const _T3_UNITS_FIXTURE = new Set([
  "BroodLord", "Ultralisk", "Lurker", "LurkerMP",
  "Carrier", "Tempest", "Mothership",
  "Battlecruiser", "Thor",
]);

/**
 * Strip T3 unit tokens from a unit-bag for the early-window timeline
 * rows. Mirrors the classifier's T3_UNITS list so the fixtures stay
 * realistic (no carriers at t=0).
 *
 * @param {Record<string, number>} units
 */
function pickNonT3(units) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const k of Object.keys(units)) {
    if (_T3_UNITS_FIXTURE.has(k)) continue;
    out[k] = units[k];
  }
  return out;
}

/**
 * Macro shape that classifies into "mid" — 2 bases, 2 tech, stats
 * capped below the late thresholds.
 */
function makeMacroMid(opts = {}) {
  const duration = opts.duration || 600;
  const bases = [
    { name: "Nexus", born_time: 0, died_time: duration },
    { name: "Nexus", born_time: 100, died_time: duration },
  ];
  const productionBuildings = [
    { name: "CyberneticsCore", born_time: 80, died_time: duration },
    { name: "TwilightCouncil", born_time: 150, died_time: duration },
  ];
  const stats = [];
  for (let t = 0; t <= duration; t += 10) {
    stats.push({
      time: t,
      food_workers: Math.min(20 + t / 10, 50),
      food_used: Math.min(12 + t / 8, 80),
      army_value: Math.min(t * 8, 3000),
    });
  }
  return {
    bases,
    production_buildings: productionBuildings,
    stats_events: stats,
    unit_timeline: [],
  };
}

/**
 * Build a 5-game fixture for the same opponent. Caller picks the
 * opponent's pulseId / displayName so the test can assert the
 * "vs <name>" col-0 label flows through.
 *
 * @param {string} userId
 * @param {{ pulseId: string, displayName: string, race?: string }} oppMeta
 */
function makeFiveGameFixture(userId, oppMeta) {
  const race = oppMeta.race || "Zerg";
  const lateUnits = { Stalker: 5, Immortal: 3, Carrier: 2, Probe: 60 };
  /** @param {string} gid */
  const baseOpponent = {
    pulseId: oppMeta.pulseId,
    toonHandle: oppMeta.pulseId,
    displayName: oppMeta.displayName,
    race,
  };
  /**
   * @param {{
   *   gameId: string,
   *   date: Date,
   *   result: string,
   *   strategy: string,
   *   macroBreakdown: object,
   *   map?: string,
   * }} g
   */
  const make = (g) => ({
    userId,
    gameId: g.gameId,
    date: g.date,
    result: g.result,
    myRace: "Protoss",
    myBuild: "Stargate Phoenix",
    map: g.map || "Map A",
    durationSec: 600,
    opponent: { ...baseOpponent, strategy: g.strategy },
    macroBreakdown: g.macroBreakdown,
  });
  return [
    make({
      gameId: "g1",
      date: new Date("2026-04-10T00:00:00Z"),
      result: "Victory",
      strategy: "Zerg - Hydra Comp",
      macroBreakdown: makeMacroLate({ units: lateUnits }),
    }),
    make({
      gameId: "g2",
      date: new Date("2026-04-11T00:00:00Z"),
      result: "Victory",
      strategy: "Zerg - Hydra Comp",
      macroBreakdown: makeMacroLate({ units: lateUnits }),
    }),
    make({
      gameId: "g3",
      date: new Date("2026-04-12T00:00:00Z"),
      result: "Defeat",
      strategy: "Zerg - Hydra Comp",
      macroBreakdown: makeMacroLate({ units: lateUnits }),
    }),
    make({
      gameId: "g4",
      date: new Date("2026-04-13T00:00:00Z"),
      result: "Victory",
      strategy: "Zerg - Roach All-In",
      macroBreakdown: makeMacroLate({ units: lateUnits }),
    }),
    make({
      gameId: "g5",
      date: new Date("2026-04-14T00:00:00Z"),
      result: "Defeat",
      strategy: "Zerg - Hydra Comp",
      macroBreakdown: makeMacroMid(),
    }),
  ];
}

describe("OpponentsService phase + transition envelope", () => {
  /** @type {MongoMemoryServer} */
  let mongo;
  /** @type {Awaited<ReturnType<typeof connect>>} */
  let db;
  /** @type {OpponentsService} */
  let opponents;
  const userId = "u_phase";
  const pulseId = "1-S2-1-9001";
  const displayName = "WallOfHydra";

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opp_phase" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
    opponents = new OpponentsService(db, Buffer.alloc(32, 1));
  });

  /**
   * Seed the opponents row + 5 matched games. The row's stored
   * displayName matches the games so the ``authoritativeName`` overlay
   * agrees on what to label col 0 with.
   */
  async function seedFixture() {
    await db.opponents.insertOne({
      userId,
      pulseId,
      toonHandle: pulseId,
      pulseCharacterId: "9001",
      displayNameSample: displayName,
      race: "Z",
      gameCount: 5,
      wins: 3,
      losses: 2,
      firstSeen: new Date("2026-04-10T00:00:00Z"),
      lastSeen: new Date("2026-04-14T00:00:00Z"),
    });
    await db.games.insertMany(
      makeFiveGameFixture(userId, { pulseId, displayName }),
    );
  }

  test("envelope carries ``phases`` and ``transitions`` fields", async () => {
    await seedFixture();
    const out = await opponents.get(userId, pulseId);
    expect(out).not.toBeNull();
    expect(out.phases).toBeDefined();
    expect(out.transitions).toBeDefined();
    // Both top-level wrappers carry the slug + opponent-name label so
    // SPA consumers that key on them (BuildTransitionSankey reads
    // ``transitions.name``) have a stable identity.
    expect(out.phases.slug).toBe(pulseId);
    expect(out.transitions.slug).toBe(pulseId);
    expect(out.transitions.name).toBe(`vs ${displayName}`);
  });

  test("phases.sampleSize counts every game at every reached phase", async () => {
    await seedFixture();
    const out = await opponents.get(userId, pulseId);
    const ss = out.phases.sampleSize;
    // All 5 games pass through Early on their way to their final
    // phase. Four reach Late (the makeMacroLate fixture is
    // calibrated to cross the late threshold). One terminates in
    // Mid — that game contributes to Early / EarlyMid / Mid only.
    expect(ss.early).toBe(5);
    expect(ss.earlyMid).toBe(5);
    expect(ss.mid).toBe(5);
    expect(ss.midLate).toBe(4);
    expect(ss.late).toBe(4);
  });

  test("phases.finalPhaseDistribution matches the fixture (4 late, 1 mid)", async () => {
    await seedFixture();
    const out = await opponents.get(userId, pulseId);
    const dist = out.phases.finalPhaseDistribution;
    expect(dist.late).toBe(4);
    expect(dist.mid).toBe(1);
    expect(dist.early).toBe(0);
    expect(dist.earlyMid).toBe(0);
    expect(dist.midLate).toBe(0);
  });

  test("phases.medianCrossings + durationP95Sec are populated", async () => {
    await seedFixture();
    const out = await opponents.get(userId, pulseId);
    const c = out.phases.medianCrossings;
    // Every "late" game crosses earlyMid / mid; the late game also
    // crosses midLate + lateAt. Medians are non-null finite seconds.
    expect(c.earlyMidAt).toBeGreaterThan(0);
    expect(c.midAt).toBeGreaterThan(0);
    expect(c.midLateAt).toBeGreaterThan(0);
    expect(c.lateAt).toBeGreaterThan(0);
    // All games are 600s long → p95 lands at 600s.
    expect(out.phases.durationP95Sec).toBe(600);
  });

  test("transitions Sankey uses the opponent column scheme", async () => {
    await seedFixture();
    const out = await opponents.get(userId, pulseId);
    const t = out.transitions.transitions;
    const col0 = t.nodes.filter((n) => n.column === 0);
    expect(col0).toHaveLength(1);
    expect(col0[0].id).toBe("opponent");
    expect(col0[0].label).toBe(`vs ${displayName}`);
    expect(col0[0].kind).toBe("build");
    expect(col0[0].games).toBe(5);

    // col 1 is the opponent's race — same value for every game in
    // the fixture, so the single node carries all 5.
    const col1 = t.nodes.filter((n) => n.column === 1);
    expect(col1).toHaveLength(1);
    expect(col1[0].id).toBe("oppRace:Zerg");
    expect(col1[0].label).toBe("Zerg");
    expect(col1[0].kind).toBe("oppRace");
    expect(col1[0].games).toBe(5);

    // col 2 is opp.strategy — "Zerg - Hydra Comp" has 4 games and
    // is dominant; "Zerg - Roach All-In" has 1 game and folds into
    // an "Other" sibling at the same column.
    const col2 = t.nodes.filter((n) => n.column === 2);
    const hydra = col2.find((n) => n.label === "Zerg - Hydra Comp");
    const otherCol2 = col2.find((n) => n.label === "Other");
    expect(hydra).toBeDefined();
    expect(hydra.kind).toBe("oppStrategy");
    expect(hydra.games).toBe(4);
    expect(col2.find((n) => n.label === "Zerg - Roach All-In"))
      .toBeUndefined();
    expect(otherCol2).toBeDefined();
    expect(otherCol2.games).toBe(1);

    // col 3 is finalPhase — "late" dominates (4 games), "mid" folds
    // into the col-3 Other sibling.
    const col3 = t.nodes.filter((n) => n.column === 3);
    const late = col3.find((n) => n.label === "late");
    const otherCol3 = col3.find((n) => n.label === "Other");
    expect(late).toBeDefined();
    expect(late.kind).toBe("finalPhase");
    expect(late.games).toBe(4);
    expect(col3.find((n) => n.label === "mid")).toBeUndefined();
    expect(otherCol3).toBeDefined();
    expect(otherCol3.games).toBe(1);
  });

  test("transitions Sankey traces the dominant opponent → race → strategy → finalPhase path", async () => {
    await seedFixture();
    const out = await opponents.get(userId, pulseId);
    const findEdge = (from, to) =>
      out.transitions.transitions.edges.find(
        (e) => e.from === from && e.to === to,
      );

    expect(findEdge("opponent", "oppRace:Zerg")).toBeDefined();
    expect(findEdge("opponent", "oppRace:Zerg").games).toBe(5);
    expect(findEdge("oppRace:Zerg", "strat:Zerg - Hydra Comp")).toBeDefined();
    expect(findEdge("oppRace:Zerg", "strat:Zerg - Hydra Comp").games).toBe(4);
    expect(findEdge("strat:Zerg - Hydra Comp", "phase:late")).toBeDefined();
    expect(findEdge("strat:Zerg - Hydra Comp", "phase:late").games).toBe(3);
  });

  test("``games`` array in the envelope does NOT carry the heavy macroBreakdown blob", async () => {
    // The classifier reads macroBreakdown server-side; the response
    // emits only the compact phase aggregates. Pinning this guard
    // prevents a future change to ``serializeGameForProfile`` from
    // re-leaking the ~6 kB-per-game blob into the JSON envelope.
    await seedFixture();
    const out = await opponents.get(userId, pulseId);
    expect(out.games).toBeDefined();
    expect(out.games.length).toBe(5);
    for (const g of out.games) {
      expect(g.macroBreakdown).toBeUndefined();
    }
  });

  test("phases.byStrategy groups games by opponent strategy with full per-phase envelopes", async () => {
    await seedFixture();
    const out = await opponents.get(userId, pulseId);
    expect(Array.isArray(out.phases.byStrategy)).toBe(true);
    // The fixture has 4 games of "Zerg - Hydra Comp" + 1 of
    // "Zerg - Roach All-In" — both kept because the cap is 6.
    const strategies = out.phases.byStrategy.map((s) => s.strategy);
    expect(strategies).toEqual(
      expect.arrayContaining(["Zerg - Hydra Comp", "Zerg - Roach All-In"]),
    );
    // The buckets sort by games desc; Hydra Comp (4 games) leads.
    expect(out.phases.byStrategy[0].strategy).toBe("Zerg - Hydra Comp");
    expect(out.phases.byStrategy[0].games).toBe(4);
    expect(out.phases.byStrategy[1].strategy).toBe("Zerg - Roach All-In");
    expect(out.phases.byStrategy[1].games).toBe(1);

    // Each bucket carries the full ``computeCompositions`` envelope —
    // same shape consumers already key on for the aggregate, just
    // filtered to this strategy's games.
    const hydra = out.phases.byStrategy[0];
    expect(hydra.phases).toBeDefined();
    expect(hydra.phases.sampleSize).toEqual(
      expect.objectContaining({
        early: expect.any(Number),
        earlyMid: expect.any(Number),
        mid: expect.any(Number),
        midLate: expect.any(Number),
        late: expect.any(Number),
      }),
    );
    expect(hydra.phases.perPhase).toBeDefined();
    expect(hydra.phases.medianCrossings).toBeDefined();
    // The race the strategy was played as — sourced from
    // ``opponent.race`` / ``oppRace`` on the games. Used by the
    // SPA's storyline cards to colour the race rail / badge.
    expect(typeof hydra.race === "string" || hydra.race === null).toBe(true);
  });

  test("empty-games opponent still returns a well-formed envelope", async () => {
    // Defensive: an opponents row that pre-dates the games (admin
    // "Rebuild" mid-cycle) or one whose games were pruned must not
    // crash the phases pipeline.
    await db.opponents.insertOne({
      userId,
      pulseId,
      toonHandle: pulseId,
      displayNameSample: displayName,
      race: "Z",
      gameCount: 0,
      wins: 0,
      losses: 0,
      firstSeen: new Date("2026-04-10T00:00:00Z"),
      lastSeen: new Date("2026-04-10T00:00:00Z"),
    });
    const out = await opponents.get(userId, pulseId);
    expect(out).not.toBeNull();
    expect(out.phases).toBeDefined();
    expect(out.phases.sampleSize.early).toBe(0);
    expect(out.transitions).toBeDefined();
    expect(out.transitions.transitions.nodes).toEqual([]);
    expect(out.transitions.transitions.edges).toEqual([]);
  });
});
