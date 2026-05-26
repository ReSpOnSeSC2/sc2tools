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

/**
 * Stateful customBuilds stub for the `apply` tests. Stores upserted
 * builds in an internal array keyed by slug (so upsert is idempotent —
 * re-upserting the same slug updates in place, just like the real
 * Mongo-backed service). reclassifyAll walks every build, runs each
 * rule set against every game's perspective-appropriate events with
 * the same race-gate the real service uses, and stamps each game's
 * `myBuild` with whichever build's rules match using the most-rules-
 * wins tiebreak. Reused for verifying that apply hands off correctly
 * to upsert + reclassifyAll without spinning up MongoMemoryServer.
 */
function applyStubServices(initialGames, initialBuilds) {
  /** @type {any[]} */
  const builds = (initialBuilds || []).map((b) => ({ ...b }));
  /** @type {any[]} */
  const games = (initialGames || []).map((g) => ({ ...g }));
  /** @type {Array<{userId: string, build: any}>} */
  const upsertCalls = [];
  /** @type {Array<{userId: string, opts: any}>} */
  const reclassifyAllCalls = [];

  function raceLetter(r) {
    if (typeof r !== "string" || r.length === 0) return "?";
    return r.charAt(0).toUpperCase();
  }

  function matchesGate(g, build, perspective) {
    const mySide = perspective === "opponent" ? g.oppRace : g.myRace;
    const oppSide = perspective === "opponent" ? g.myRace : g.oppRace;
    if (build.race && build.race !== "Any") {
      if (!mySide) return false;
      if (raceLetter(mySide) !== raceLetter(build.race)) return false;
    }
    if (build.vsRace && build.vsRace !== "Any") {
      if (!oppSide) return false;
      if (raceLetter(oppSide) !== raceLetter(build.vsRace)) return false;
    }
    return true;
  }

  const customBuilds = {
    list: jest.fn(async () => {
      const out = builds.slice();
      out.sort(
        (a, b) =>
          (b.updatedAt ? b.updatedAt.getTime() : 0) -
          (a.updatedAt ? a.updatedAt.getTime() : 0),
      );
      return out;
    }),
    upsert: jest.fn(async (userId, build) => {
      upsertCalls.push({ userId, build: JSON.parse(JSON.stringify(build)) });
      const now = new Date();
      const idx = builds.findIndex((b) => b && b.slug === build.slug);
      if (idx >= 0) {
        builds[idx] = {
          ...builds[idx],
          ...build,
          userId,
          updatedAt: now,
        };
      } else {
        builds.push({
          ...build,
          userId,
          createdAt: now,
          updatedAt: now,
        });
      }
    }),
    reclassifyAll: jest.fn(async (userId, opts) => {
      reclassifyAllCalls.push({ userId, opts: opts || {} });
      /** @type {Map<string, {name: string, ruleCount: number, ord: number}>} */
      const claims = new Map();
      const ordered = builds
        .slice()
        .sort(
          (a, b) =>
            (b.updatedAt ? b.updatedAt.getTime() : 0) -
            (a.updatedAt ? a.updatedAt.getTime() : 0),
        );
      const ownedNames = new Set();
      const perBuild = [];
      for (let i = 0; i < ordered.length; i++) {
        const b = ordered[i];
        const buildName = b.name || b.slug;
        ownedNames.add(buildName);
        const rules = Array.isArray(b.rules) ? b.rules : [];
        let matched = 0;
        if (rules.length === 0) {
          perBuild.push({
            slug: b.slug,
            name: buildName,
            matched: 0,
            tagged: 0,
          });
          continue;
        }
        const perspective = b.perspective === "opponent" ? "opponent" : "you";
        for (const g of games) {
          if (!matchesGate(g, b, perspective)) continue;
          const events =
            perspective === "opponent" ? g.oppEvents || [] : g.events || [];
          if (events.length === 0) continue;
          let pass;
          try {
            pass = evaluateRules(rules, events).pass;
          } catch (_e) {
            pass = false;
          }
          if (!pass) continue;
          matched++;
          const cur = claims.get(g.gameId);
          if (
            !cur ||
            rules.length > cur.ruleCount ||
            (rules.length === cur.ruleCount && i < cur.ord)
          ) {
            claims.set(g.gameId, {
              name: buildName,
              ruleCount: rules.length,
              ord: i,
            });
          }
        }
        perBuild.push({
          slug: b.slug,
          name: buildName,
          matched,
          tagged: 0,
        });
      }
      let tagged = 0;
      for (const [gid, claim] of claims) {
        const g = games.find((x) => x.gameId === gid);
        if (!g) continue;
        if (g.myBuild !== claim.name) {
          g.myBuild = claim.name;
          tagged++;
          const row = perBuild.find((p) => p.name === claim.name);
          if (row) row.tagged += 1;
        }
      }
      let cleared = 0;
      if (opts && opts.clearUnmatched) {
        for (const g of games) {
          if (typeof g.myBuild !== "string") continue;
          if (!ownedNames.has(g.myBuild)) continue;
          if (claims.has(g.gameId)) continue;
          g.myBuild = null;
          cleared++;
        }
      }
      return {
        builds: builds.length,
        scanned: games.length,
        tagged,
        cleared,
        perBuild,
      };
    }),
  };
  return { customBuilds, builds, games, upsertCalls, reclassifyAllCalls };
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

describe("AutoClassifyService.apply — acceptance", () => {
  beforeEach(() => {
    nextId = 0;
  });

  test("applying a candidate creates a custom build and tags the cluster's games", async () => {
    // 5 unclassified Stargate games — discover → apply round-trip.
    // After apply: list() includes the new build, and each cluster
    // game's myBuild has been stamped with the new name through
    // reclassifyAll.
    const games = fiveStargateGames(null);
    const stubs = applyStubServices(games, []);
    const perGame = {
      listForRulePreview: jest.fn(async () => stubs.games.slice()),
    };
    const svc = new AutoClassifyService({
      perGame,
      customBuilds: stubs.customBuilds,
    });

    const candidates = await svc.discover("user-apply-1");
    expect(candidates).toHaveLength(1);

    const result = await svc.apply("user-apply-1", candidates);
    expect(result.created).toEqual([candidates[0].proposedSlug]);
    expect(stubs.upsertCalls).toHaveLength(1);
    const persisted = stubs.upsertCalls[0].build;
    expect(persisted).toMatchObject({
      slug: candidates[0].proposedSlug,
      name: candidates[0].proposedName,
      race: "Protoss",
      vsRace: "Zerg",
      perspective: "you",
      schemaVersion: 3,
      source: "auto-classify",
    });
    expect(Array.isArray(persisted.rules)).toBe(true);
    expect(persisted.rules.length).toBeGreaterThan(0);
    expect(typeof persisted.description).toBe("string");
    expect(persisted.description).toMatch(/Auto-classified/);
    expect(persisted.description).toMatch(/PvZ/);

    // reclassifyAll fires exactly once, with clearUnmatched stuck false
    // — a freshly created auto build must NEVER clear tags from games
    // owned by the agent's named catalog.
    expect(stubs.reclassifyAllCalls).toHaveLength(1);
    expect(stubs.reclassifyAllCalls[0].opts).toEqual({ clearUnmatched: false });

    // The new build is now in the user's library.
    const after = await stubs.customBuilds.list("user-apply-1");
    expect(after).toHaveLength(1);
    expect(after[0].slug).toBe(candidates[0].proposedSlug);

    // All 5 cluster games carry the new build's name.
    const taggedNames = new Set(stubs.games.map((g) => g.myBuild));
    expect(taggedNames.size).toBe(1);
    expect(taggedNames.has(candidates[0].proposedName)).toBe(true);

    // reclassify summary surfaces through apply's return value.
    expect(result.builds).toBe(1);
    expect(result.tagged).toBe(5);
  });

  test("a previously-named game keeps its tag when a more-specific build owns it", async () => {
    // Setup: 5 Stargate games tagged with an existing custom build's
    // name; the existing build's 3 rules ALL match those games. We
    // call apply with a manually-crafted 1-rule candidate that would
    // also match. reclassifyAll's closest-match rule (more rules
    // wins) must hand the games to the existing build, leaving the
    // auto build a real row but owning no games.
    //
    // Bypasses discover() on purpose: a discover-then-apply flow
    // would never produce this candidate because isAlreadyClassified
    // would exclude these games from the scan. The point of this
    // test is the apply orchestration layer, not the discover one.
    const games = fiveStargateGames("PvZ - Existing Build");
    const existingBuild = {
      slug: "existing-build",
      name: "PvZ - Existing Build",
      race: "Protoss",
      vsRace: "Zerg",
      perspective: "you",
      schemaVersion: 3,
      rules: [
        { type: "before", name: "BuildStargate", time_lt: 240 },
        { type: "before", name: "BuildPhoenix", time_lt: 360 },
        { type: "before", name: "BuildFleetBeacon", time_lt: 360 },
      ],
      updatedAt: new Date("2026-04-01T00:00:00Z"),
    };
    const stubs = applyStubServices(games, [existingBuild]);
    const perGame = {
      listForRulePreview: jest.fn(async () => stubs.games.slice()),
    };
    const svc = new AutoClassifyService({
      perGame,
      customBuilds: stubs.customBuilds,
    });

    const candidate = {
      proposedName: "PvZ - Auto Stargate",
      proposedSlug: "pvz-auto-stargate",
      race: "Protoss",
      vsRace: "Zerg",
      perspective: "you",
      rules: [{ type: "before", name: "BuildStargate", time_lt: 240 }],
    };
    await svc.apply("user-apply-2", [candidate]);

    // Both builds exist now.
    const after = await stubs.customBuilds.list("user-apply-2");
    expect(after.map((b) => b.slug).sort()).toEqual(
      ["existing-build", "pvz-auto-stargate"].sort(),
    );

    // Every cluster game still carries the existing build's name —
    // the more-specific build kept ownership.
    for (const g of stubs.games) {
      expect(g.myBuild).toBe("PvZ - Existing Build");
    }
  });

  test("re-applying the same candidate is idempotent — 0 duplicates", async () => {
    const games = fiveStargateGames(null);
    const stubs = applyStubServices(games, []);
    const perGame = {
      listForRulePreview: jest.fn(async () => stubs.games.slice()),
    };
    const svc = new AutoClassifyService({
      perGame,
      customBuilds: stubs.customBuilds,
    });

    const candidates = await svc.discover("user-apply-3");
    expect(candidates).toHaveLength(1);

    await svc.apply("user-apply-3", candidates);
    const afterFirst = await stubs.customBuilds.list("user-apply-3");
    expect(afterFirst).toHaveLength(1);

    // Same candidate (same slug, same rules) — upsert is keyed on
    // (userId, slug), so the second apply updates in place.
    await svc.apply("user-apply-3", candidates);
    const afterSecond = await stubs.customBuilds.list("user-apply-3");
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].slug).toBe(candidates[0].proposedSlug);

    // upsert WAS called both times; reclassifyAll WAS called both
    // times. Idempotency is about the resulting state, not the call
    // count — every apply re-runs the global reclassify so the user
    // can edit a candidate's name in the UI and re-apply to rename.
    expect(stubs.upsertCalls).toHaveLength(2);
    expect(stubs.reclassifyAllCalls).toHaveLength(2);
  });

  test("rejects the whole batch when any candidate fails validation", async () => {
    // One good + one malformed candidate: nothing should land. The
    // service throws with a structured `details` payload so the
    // route layer (separate prompt) can return per-row errors.
    const stubs = applyStubServices([], []);
    const perGame = {
      listForRulePreview: jest.fn(async () => []),
    };
    const svc = new AutoClassifyService({
      perGame,
      customBuilds: stubs.customBuilds,
    });

    const good = {
      proposedName: "PvZ - Good",
      proposedSlug: "pvz-good",
      race: "Protoss",
      vsRace: "Zerg",
      perspective: "you",
      rules: [{ type: "before", name: "BuildStargate", time_lt: 240 }],
    };
    const bad = {
      // Empty proposedSlug fails the slug pattern.
      proposedName: "",
      proposedSlug: "",
      race: "Protoss",
      vsRace: "Zerg",
      perspective: "you",
      rules: [{ type: "before", name: "BuildStargate", time_lt: 240 }],
    };

    let thrown = null;
    try {
      await svc.apply("user-apply-4", [good, bad]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.message).toMatch(/invalid_candidates/);
    expect(thrown.status).toBe(400);
    expect(Array.isArray(thrown.details)).toBe(true);
    expect(thrown.details.length).toBeGreaterThan(0);

    // Nothing persisted — the good row was held back so the batch
    // stays all-or-nothing.
    expect(stubs.upsertCalls).toHaveLength(0);
    expect(stubs.reclassifyAllCalls).toHaveLength(0);
    expect(stubs.builds).toHaveLength(0);
  });

  test("rejects an empty candidate list", async () => {
    const stubs = applyStubServices([], []);
    const perGame = {
      listForRulePreview: jest.fn(async () => []),
    };
    const svc = new AutoClassifyService({
      perGame,
      customBuilds: stubs.customBuilds,
    });
    let thrown = null;
    try {
      await svc.apply("user-apply-5", []);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.message).toMatch(/candidates_required/);
    expect(stubs.upsertCalls).toHaveLength(0);
    expect(stubs.reclassifyAllCalls).toHaveLength(0);
  });
});
