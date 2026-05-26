"use strict";

/**
 * Tests for AutoClassifyService.discover.
 *
 * Hermetic: no Mongo, no Clerk, no HTTP. We hand-build an in-memory
 * `perGame` and `customBuilds` stub (just the two methods discover()
 * actually calls — `listForRulePreview` and `list`) and drive the
 * service directly. That keeps the suite focused on the three
 * acceptance scenarios from the discovery-engine spec:
 *
 *   1. A game already tagged with a real (non-unclassified) build is
 *      excluded from the scan.
 *   2. A game whose events satisfy an existing user custom build's
 *      rules is excluded — even if its `myBuild` is empty — because
 *      `/reclassify` would already claim it.
 *   3. A 5-game lookalike group sitting in the unclassified bucket
 *      becomes exactly one candidate with the correct matchup,
 *      gameCount: 5, and rules that validate every cluster game.
 *
 * Plus sanity for the collision guard, perspective='opponent', and
 * mixed-matchup buckets.
 */

const {
  AutoClassifyService,
  UNCLASSIFIED_LABEL_RE,
} = require("../src/services/autoClassify");
const { evaluateRules } = require("../src/services/buildRulesEvaluator");

function building(name, time) {
  return { name, time, is_building: true, category: "building" };
}
function unit(name, time) {
  return { name, time, category: "unit" };
}

/** Stargate → Phoenix → FleetBeacon → Tempest, with `w` seconds of wobble. */
function stargateOpening(w = 0) {
  return [
    building("Gateway", 75 + w),
    building("CyberneticsCore", 115 + w),
    building("Stargate", 200 + w),
    unit("Phoenix", 280 + w),
    building("FleetBeacon", 310 + w),
    unit("Tempest", 400 + w),
  ];
}

/** Robo → Immortal → Colossus, with `w` seconds of wobble. */
function roboOpening(w = 0) {
  return [
    building("Gateway", 78 + w),
    building("CyberneticsCore", 118 + w),
    building("RoboticsFacility", 200 + w),
    unit("Immortal", 285 + w),
    unit("Observer", 310 + w),
    building("RoboticsBay", 330 + w),
    unit("Colossus", 410 + w),
  ];
}

/** Distinct ZvP signature — Hydra/Lurker rush from the Zerg side. */
function zergHydraLurker(w = 0) {
  return [
    building("SpawningPool", 80 + w),
    building("RoachWarren", 180 + w),
    building("HydraliskDen", 240 + w),
    unit("Hydralisk", 300 + w),
    building("LurkerDen", 360 + w),
    unit("Lurker", 430 + w),
  ];
}

let nextId = 0;
function makeGame(opts = {}) {
  nextId += 1;
  return {
    gameId: opts.gameId || `g${nextId}`,
    myRace: opts.myRace || "Protoss",
    oppRace: opts.oppRace || "Zerg",
    opponent: { race: opts.oppRace || "Zerg" },
    myBuild: opts.myBuild === undefined ? null : opts.myBuild,
    buildLog: [],
    oppBuildLog: [],
    events: opts.events || stargateOpening(0),
    oppEvents: opts.oppEvents || [],
    result: opts.result || "Win",
    date: opts.date || new Date("2026-05-01T00:00:00Z"),
    map: opts.map || "Goldenaura LE",
    durationSec: opts.durationSec || 720,
    macroScore: 50,
    apm: 150,
    spq: 50,
  };
}

function stubServices(games, builds) {
  const perGame = {
    listForRulePreview: jest.fn(async () => games.slice()),
  };
  const customBuilds = {
    list: jest.fn(async () => builds.slice()),
  };
  return { perGame, customBuilds };
}

function fiveStargateGames(myBuild = null) {
  return [0, 2, 4, 6, 8].map((w, i) =>
    makeGame({
      gameId: `s${i + 1}`,
      events: stargateOpening(w),
      myBuild,
    }),
  );
}

describe("UNCLASSIFIED_LABEL_RE", () => {
  test("matches the Python core's catch-all labels", () => {
    expect(UNCLASSIFIED_LABEL_RE.test("Macro Transition (Unclassified)")).toBe(
      true,
    );
    expect(UNCLASSIFIED_LABEL_RE.test("Macro Transition - PvZ")).toBe(true);
    expect(UNCLASSIFIED_LABEL_RE.test("Unclassified - PvZ")).toBe(true);
    expect(UNCLASSIFIED_LABEL_RE.test("Default")).toBe(true);
  });

  test("does not match real build names", () => {
    expect(UNCLASSIFIED_LABEL_RE.test("PvZ - Stargate into Robo")).toBe(false);
    expect(UNCLASSIFIED_LABEL_RE.test("PvT - 2-Gate Robo")).toBe(false);
    expect(UNCLASSIFIED_LABEL_RE.test("Cheese Cannon Rush")).toBe(false);
  });
});

describe("AutoClassifyService.discover — constructor", () => {
  test("throws when required deps are missing", () => {
    expect(() => new AutoClassifyService()).toThrow();
    expect(() => new AutoClassifyService({})).toThrow(/customBuilds/);
    expect(() => new AutoClassifyService({ customBuilds: {} })).toThrow(
      /perGame/,
    );
  });
});

describe("AutoClassifyService.discover — acceptance", () => {
  beforeEach(() => {
    nextId = 0;
  });

  test("a 5-game lookalike group in the unclassified bucket yields one candidate", async () => {
    const games = fiveStargateGames(null);
    const { perGame, customBuilds } = stubServices(games, []);
    const svc = new AutoClassifyService({ perGame, customBuilds });

    const candidates = await svc.discover("user-1");

    expect(candidates).toHaveLength(1);
    const [c] = candidates;
    expect(c.matchup).toBe("PvZ");
    expect(c.perspective).toBe("you");
    expect(c.gameCount).toBe(5);
    expect(c.race).toBe("Protoss");
    expect(c.vsRace).toBe("Zerg");
    expect(c.proposedName.startsWith("PvZ - ")).toBe(true);
    expect(c.proposedSlug).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(Array.isArray(c.rules)).toBe(true);
    expect(c.rules.length).toBeGreaterThan(0);
    // Every cluster game should pass the derived rules — self-match
    // round-trip with the same evaluator /reclassify uses.
    for (const g of games) {
      expect(evaluateRules(c.rules, g.events).pass).toBe(true);
    }
    expect(c.selfMatchRate).toBe(1);
    expect(c.sampleGames.length).toBeGreaterThan(0);
    expect(c.sampleGames.length).toBeLessThanOrEqual(5);
    for (const s of c.sampleGames) {
      expect(typeof s.gameId).toBe("string");
    }
  });

  test("a game already tagged with a real build is excluded from the scan", async () => {
    // Five unclassified Stargate games + one tagged with a real
    // build name. The tagged one must NOT inflate gameCount.
    const games = [
      ...fiveStargateGames(null),
      makeGame({
        gameId: "tagged",
        events: stargateOpening(1),
        myBuild: "PvZ - Stargate into Robo",
      }),
    ];
    const { perGame, customBuilds } = stubServices(games, []);
    const svc = new AutoClassifyService({ perGame, customBuilds });

    const candidates = await svc.discover("user-2");

    expect(candidates).toHaveLength(1);
    const [c] = candidates;
    expect(c.gameCount).toBe(5);
    const ids = new Set(c.sampleGames.map((s) => s.gameId));
    expect(ids.has("tagged")).toBe(false);
  });

  test("a game matching an existing custom build's rules is excluded", async () => {
    // Five Stargate games — one of them sits in the unclassified
    // bucket BUT its events satisfy a user-saved custom build's
    // rules. /reclassify would already claim it, so the discovery
    // engine must exclude it: only 4 in-scope games remain, below
    // the 5-game gate, so we get zero candidates.
    const games = fiveStargateGames(null);
    const existingBuild = {
      slug: "my-stargate",
      name: "PvZ - My Stargate Build",
      race: "Protoss",
      vsRace: "Zerg",
      perspective: "you",
      rules: [
        // A rule that every Stargate-opening game satisfies — fires
        // for the same set the auto-classifier would otherwise pick up.
        { type: "before", name: "BuildStargate", time_lt: 240 },
      ],
    };
    const { perGame, customBuilds } = stubServices(games, [existingBuild]);
    const svc = new AutoClassifyService({ perGame, customBuilds });

    const candidates = await svc.discover("user-3");

    expect(candidates).toHaveLength(0);
  });

  test("filterMatchingGames drops claimed games but leaves the unclaimed group intact", async () => {
    // Five Stargate games + five Robo games. A saved custom build
    // covers Stargate ONLY — the Robo cluster should still surface.
    const stargate = fiveStargateGames(null);
    const robo = [0, 2, 4, 6, 8].map((w, i) =>
      makeGame({
        gameId: `r${i + 1}`,
        events: roboOpening(w),
        myBuild: null,
      }),
    );
    const existingBuild = {
      slug: "my-stargate",
      name: "PvZ - My Stargate Build",
      race: "Protoss",
      vsRace: "Zerg",
      perspective: "you",
      rules: [{ type: "before", name: "BuildStargate", time_lt: 240 }],
    };
    const { perGame, customBuilds } = stubServices(
      [...stargate, ...robo],
      [existingBuild],
    );
    const svc = new AutoClassifyService({ perGame, customBuilds });

    const candidates = await svc.discover("user-4");

    expect(candidates).toHaveLength(1);
    expect(candidates[0].gameCount).toBe(5);
    // The remaining cluster is the Robo one — confirm by checking
    // the proposed name carries the Robo lead tech.
    expect(candidates[0].proposedName).toMatch(/Robo/);
  });
});

describe("AutoClassifyService.discover — collision guard", () => {
  beforeEach(() => {
    nextId = 0;
  });

  test("appends (Auto) suffix when the proposed name matches an existing build", async () => {
    const games = fiveStargateGames(null);
    const { perGame, customBuilds: stubCustomBuilds } = stubServices(games, []);
    const svcPeek = new AutoClassifyService({
      perGame,
      customBuilds: stubCustomBuilds,
    });
    const initial = await svcPeek.discover("user-collision-peek");
    expect(initial).toHaveLength(1);
    const conflict = {
      slug: initial[0].proposedSlug,
      name: initial[0].proposedName,
      race: "Protoss",
      vsRace: "Zerg",
      perspective: "you",
      rules: [{ type: "before", name: "BuildHatchery", time_lt: 1 }],
    };
    const games2 = fiveStargateGames(null);
    const { perGame: pg2, customBuilds: cb2 } = stubServices(games2, [
      conflict,
    ]);
    const svc = new AutoClassifyService({ perGame: pg2, customBuilds: cb2 });
    const candidates = await svc.discover("user-collision");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].proposedName).not.toBe(conflict.name);
    expect(candidates[0].proposedSlug).not.toBe(conflict.slug);
    expect(candidates[0].proposedName).toMatch(/\(Auto\)?/);
  });

  test("never proposes a name already used by a non-unclassified myBuild", async () => {
    // Six Stargate games — five unclassified + one tagged with a name
    // the discovery engine WOULD normally pick. The proposal should
    // shift to the (Auto) variant.
    const games = fiveStargateGames(null);
    // Peek to find the would-be name.
    const { perGame: pgPeek, customBuilds: cbPeek } = stubServices(
      games.map((g) => ({ ...g })),
      [],
    );
    const peek = await new AutoClassifyService({
      perGame: pgPeek,
      customBuilds: cbPeek,
    }).discover("peek-user");
    expect(peek).toHaveLength(1);
    const realName = peek[0].proposedName;
    const tagged = makeGame({
      gameId: "tagged-collision",
      events: roboOpening(0),
      myBuild: realName,
    });
    const games2 = [...fiveStargateGames(null), tagged];
    const { perGame, customBuilds } = stubServices(games2, []);
    const svc = new AutoClassifyService({ perGame, customBuilds });
    const candidates = await svc.discover("user-name-reserved");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].proposedName).not.toBe(realName);
  });
});

describe("AutoClassifyService.discover — robustness", () => {
  beforeEach(() => {
    nextId = 0;
  });

  test("returns [] when there are no games at all", async () => {
    const { perGame, customBuilds } = stubServices([], []);
    const svc = new AutoClassifyService({ perGame, customBuilds });
    expect(await svc.discover("empty-user")).toEqual([]);
  });

  test("returns [] when every game is already classified", async () => {
    const games = fiveStargateGames("PvZ - Stargate into Robo");
    const { perGame, customBuilds } = stubServices(games, []);
    const svc = new AutoClassifyService({ perGame, customBuilds });
    expect(await svc.discover("classified-user")).toEqual([]);
  });

  test("drops games with missing race fields from the scan", async () => {
    const games = fiveStargateGames(null).map((g, i) =>
      i === 0 ? { ...g, myRace: null, oppRace: null } : g,
    );
    const { perGame, customBuilds } = stubServices(games, []);
    const svc = new AutoClassifyService({ perGame, customBuilds });
    const candidates = await svc.discover("user-no-race");
    // 4 games left after the race filter — below the 5-game gate.
    expect(candidates).toEqual([]);
  });

  test("sorts candidates by gameCount desc", async () => {
    // 6 PvZ Stargate games + 5 PvT Robo games — both clusters
    // survive, but the PvZ one is larger and should sort first.
    const pvz = [0, 2, 4, 6, 8, 10].map((w, i) =>
      makeGame({
        gameId: `pvz${i + 1}`,
        myRace: "Protoss",
        oppRace: "Zerg",
        events: stargateOpening(w),
      }),
    );
    const pvt = [0, 2, 4, 6, 8].map((w, i) =>
      makeGame({
        gameId: `pvt${i + 1}`,
        myRace: "Protoss",
        oppRace: "Terran",
        events: roboOpening(w),
      }),
    );
    const { perGame, customBuilds } = stubServices([...pvz, ...pvt], []);
    const svc = new AutoClassifyService({ perGame, customBuilds });
    const candidates = await svc.discover("user-sorted");
    expect(candidates).toHaveLength(2);
    expect(candidates[0].gameCount).toBe(6);
    expect(candidates[0].matchup).toBe("PvZ");
    expect(candidates[1].gameCount).toBe(5);
    expect(candidates[1].matchup).toBe("PvT");
  });

  test("perspective='opponent' clusters on opp events and assigns opp's race", async () => {
    // User is Protoss, opponent is Zerg, and the opponent ran a
    // Hydra/Lurker opening 5 times. perspective='opponent' should
    // surface a Zerg-side build with race='Zerg', vsRace='Protoss'.
    const games = [0, 2, 4, 6, 8].map((w, i) =>
      makeGame({
        gameId: `op${i + 1}`,
        myRace: "Protoss",
        oppRace: "Zerg",
        events: [],
        oppEvents: zergHydraLurker(w),
      }),
    );
    const { perGame, customBuilds } = stubServices(games, []);
    const svc = new AutoClassifyService({ perGame, customBuilds });
    const candidates = await svc.discover("user-opp", { perspective: "opponent" });
    expect(candidates).toHaveLength(1);
    const [c] = candidates;
    expect(c.perspective).toBe("opponent");
    expect(c.race).toBe("Zerg");
    expect(c.vsRace).toBe("Protoss");
    // Matchup string follows the cloud's convention (myRace first):
    expect(c.matchup).toBe("PvZ");
  });
});
