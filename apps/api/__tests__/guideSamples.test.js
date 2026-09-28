// @ts-nocheck
"use strict";

/**
 * services/guideSamples.js — pure extraction (milestones via the shared
 * build-log parser, army snapshots from unit_timeline), the capture
 * contract (sync, never throws, bounded fire-and-forget writes, counters)
 * and the ingest-budget benchmark. Mongo-backed behaviour (full POST
 * /v1/games, GDPR) lives in guideSamplesIngest.test.js.
 */

const { performance } = require("perf_hooks");
const { GuideSamplesService, extractSample, MAX_PENDING_WRITES } = require("../src/services/guideSamples");
const { guideUserHash, guideGameHash } = require("../src/util/guideHash");

const PEPPER = Buffer.alloc(32, 5);

/** An eligible PvZ ladder game as the ingest route sees it. */
function ingestGame(overrides = {}) {
  return {
    gameId: "2026-07-01T12:00:00|SecretFoe|Site Delta LE|700",
    date: "2026-07-01T12:00:00.000Z",
    result: "Victory",
    myRace: "Protoss",
    myBuild: "PvZ - Stargate into Glaives",
    map: "Site Delta LE",
    durationSec: 700,
    playerCount: 2,
    isLadderGame: true,
    gameVersion: "5.0.16.97425",
    buildLog: [
      "[0:00] Nexus", "[0:00] Probe", "[0:18] Pylon", "[0:40] Gateway", "[0:48] Assimilator",
      "[1:30] Nexus", "[1:43] CyberneticsCore", "[3:05] Stargate", "[4:31] TwilightCouncil",
      "[5:40] Nexus", "[6:20] AdeptPiercingAttack", "[6:21] WarpGateResearch",
    ],
    macroBreakdown: {
      unit_timeline: [
        { time: 350, my: { Adept: 4, Oracle: 1, Probe: 40 }, opp: { Zergling: 12 } },
        { time: 364, my: { Adept: 6, Oracle: 1, AdeptPhaseShift: 2, Probe: 44 }, opp: {} },
        { time: 470, my: { Adept: 8, WarpPrismPhasing: 1, Stalker: 2 }, opp: {} },
        { time: 700, my: { Adept: 10 }, opp: {} },
      ],
    },
    opponent: { displayName: "SecretFoe", race: "Zerg", leagueId: 4, mmr: 4120, pulseId: "1-S2-1-424242", toonHandle: "1-S2-1-424242" },
    ...overrides,
  };
}

function fakeDb(impl = {}) {
  return {
    guideSamples: {
      updateOne: jest.fn(impl.updateOne || (async () => ({ acknowledged: true }))),
      deleteOne: jest.fn(impl.deleteOne || (async () => ({ deletedCount: 1 }))),
      deleteMany: jest.fn(impl.deleteMany || (async () => ({ deletedCount: 2 }))),
    },
  };
}

function silentLogger() {
  return { debug: jest.fn(), warn: jest.fn(), info: jest.fn() };
}

describe("extractSample", () => {
  test("distils an eligible game into compact sample fields", () => {
    const sample = extractSample(ingestGame());
    expect(sample).toEqual({
      buildKey: "PvZ - Stargate into Glaives",
      matchup: "PvZ",
      era: "after",
      leagueBand: 4,
      mmrBand: 4000,
      result: "Victory",
      map: "Site Delta LE",
      durationSec: 700,
      milestones: {
        Pylon: 18, Gateway: 40, Assimilator: 48, "Nexus#2": 90, CyberneticsCore: 103,
        Stargate: 185, TwilightCouncil: 271, "Nexus#3": 340, AdeptPiercingAttack: 380, WarpGateResearch: 381,
      },
      army: {
        360: { Adept: 6, Oracle: 1 },
        480: { Adept: 8, Stalker: 2, WarpPrism: 1 },
      },
    });
    expect(Object.keys(sample.army)).toEqual(["360", "480"]);
  });

  test("carries no user, game, opponent or identity data", () => {
    const text = JSON.stringify(extractSample(ingestGame()));
    for (const needle of ["SecretFoe", "424242", "gameId", "userId", "pulseId", "toonHandle", "displayName", "2026-07-01T12"]) {
      expect(text).not.toContain(needle);
    }
  });

  test("matches milestone names case-insensitively and counts occurrences", () => {
    const sample = extractSample(ingestGame({
      myRace: "Zerg",
      myBuild: "ZvP - Ling Bane Bust",
      opponent: { race: "Protoss", leagueId: 2 },
      buildLog: ["[0:00] Hatchery", "[0:50] Hatchery", "[1:05] SpawningPool", "[2:40] hatchery", "[3:42] zerglingmovementspeed"],
      macroBreakdown: undefined,
    }));
    expect(sample.milestones).toEqual({ "Hatchery#2": 50, SpawningPool: 65, "Hatchery#3": 160, ZerglingMovementSpeed: 222 });
    expect(sample.army).toEqual({});
  });

  test("army: nearest sample within tolerance, earlier on ties; unreached checkpoints omitted", () => {
    const sample = extractSample(ingestGame({
      durationSec: 500,
      macroBreakdown: {
        unit_timeline: [
          { time: 340, my: { Stalker: 1 } }, // 20 s away: out of tolerance
          { time: 352, my: { Stalker: 2 } }, // 8 s before
          { time: 368, my: { Stalker: 3 } }, // 8 s after → tie, earlier wins
          { time: 490, my: {} },             // present, zero army
          { time: 600, my: { Stalker: 9 } }, // game ended at 500 s
        ],
      },
    }));
    expect(sample.army).toEqual({ 360: { Stalker: 2 }, 480: {} });
  });

  test("army: canonical names, non-army noise dropped, top 8 by count then name", () => {
    const my = {
      SiegeTankSieged: 2, SiegeTank: 1, Marine: 20, Marauder: 6, Medivac: 3, WidowMine: 2, Viking: 2,
      VikingAssault: 1, Liberator: 1, Cyclone: 1, Hellion: 1, SCV: 50, MULE: 2, Overlord: 3,
      "Bad.Name": 4, ChangelingMarine: 1, KD8Charge: 5, AutoTurret: 1,
    };
    const sample = extractSample(ingestGame({
      myRace: "Terran", myBuild: "TvZ - 3 CC Bio", opponent: { race: "Zerg", leagueId: 5 },
      macroBreakdown: { unit_timeline: [{ time: 360, my }] },
    }));
    expect(sample.army[360]).toEqual({
      Marine: 20, Marauder: 6, SiegeTank: 3, Medivac: 3, Viking: 3, WidowMine: 2, Cyclone: 1, Hellion: 1,
    });
  });

  test.each([
    ["team game", { playerCount: 4 }, "not_1v1"],
    ["non-ladder", { isLadderGame: false }, "not_ladder"],
    ["resumed", { isResumedFromReplay: true }, "resumed"],
    ["custom name", { myBuild: "My private build" }, "not_guide_build"],
    ["game too short", { myBuild: "PvZ - Game Too Short" }, "not_guide_build"],
    ["random race", { myRace: "Random" }, "bad_matchup"],
    ["no build log", { buildLog: undefined }, "no_build_log"],
    ["garbage build log", { buildLog: ["nonsense", "[12:3] Bad", "[0:05] BeaconArmy"] }, "no_build_log"],
    ["bad result", { result: "Unknown" }, "bad_result"],
    ["no map", { map: "" }, "bad_map"],
    ["no era", { gameVersion: undefined, date: "garbage" }, "no_era"],
  ])("skips: %s", (_label, overrides, reason) => {
    expect(extractSample(ingestGame(overrides))).toEqual({ skip: reason });
  });

  test("malformed timeline entries are ignored, never thrown on", () => {
    const sample = extractSample(ingestGame({
      macroBreakdown: {
        unit_timeline: [null, 7, { time: "360", my: { Adept: 1 } }, { time: 361, my: [] },
          { time: 480, my: { Adept: "5", Stalker: -1, Zealot: Infinity, Sentry: 0.4, Immortal: 2 } }],
      },
    }));
    expect(sample.army).toEqual({ 360: {}, 480: { Immortal: 2 } });
    expect(extractSample(ingestGame({ macroBreakdown: { unit_timeline: "nope" } })).army).toEqual({});
  });
});

describe("GuideSamplesService.capture", () => {
  test("is synchronous, keys the upsert by HMACs and counts the write", async () => {
    const db = fakeDb();
    const svc = new GuideSamplesService(db, { pepper: PEPPER, logger: silentLogger(), disabled: false, now: () => 1_000 });
    const game = ingestGame();
    expect(svc.capture("u_1", game)).toBeUndefined();
    expect(svc.counters).toEqual({ captured: 0, skipped: 0, failed: 0, dropped: 0 });
    await svc.drain();
    expect(svc.counters.captured).toBe(1);
    const [filter, update, options] = db.guideSamples.updateOne.mock.calls[0];
    expect(filter).toEqual({
      userHash: guideUserHash(PEPPER, "u_1"),
      gameHash: guideGameHash(PEPPER, "u_1", game.gameId),
    });
    expect(update.$set).toMatchObject({ buildKey: game.myBuild, matchup: "PvZ", updatedAt: new Date(1_000) });
    expect(update.$setOnInsert).toEqual({ createdAt: new Date(1_000), _schemaVersion: 1 });
    expect(options).toEqual({ upsert: true });
    const text = JSON.stringify([filter, update]);
    expect(text).not.toContain("u_1");
    expect(text).not.toContain("SecretFoe");
  });

  test("never throws or rejects: bad input, extraction errors, write failures", async () => {
    const db = fakeDb({ updateOne: async () => { throw Object.assign(new Error("boom"), { code: 42 }); } });
    const logger = silentLogger();
    const svc = new GuideSamplesService(db, { pepper: PEPPER, logger, disabled: false });
    const hostile = ingestGame();
    Object.defineProperty(hostile, "buildLog", { get() { throw new Error("getter"); } });
    expect(() => {
      svc.capture(undefined, ingestGame());
      svc.capture("u_1", null);
      svc.capture("u_1", ingestGame({ isLadderGame: false }));
      svc.capture("u_1", hostile);
      svc.capture("u_1", ingestGame());
    }).not.toThrow();
    await svc.drain();
    expect(svc.counters).toEqual({ captured: 0, skipped: 3, failed: 2, dropped: 0 });
    for (const [fields] of logger.warn.mock.calls) {
      expect(Object.keys(fields).sort()).toEqual(["code", "codeName", "reason"]);
    }
  });

  test("bounds in-flight writes and drops (counted) beyond the cap", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const db = fakeDb({ updateOne: () => gate });
    const svc = new GuideSamplesService(db, { pepper: PEPPER, logger: silentLogger(), disabled: false });
    for (let i = 0; i < MAX_PENDING_WRITES + 5; i += 1) svc.capture("u_1", ingestGame({ gameId: `g-${i}` }));
    expect(db.guideSamples.updateOne).toHaveBeenCalledTimes(MAX_PENDING_WRITES);
    expect(svc.counters.dropped).toBe(5);
    release({});
    await svc.drain();
    expect(svc.counters.captured).toBe(MAX_PENDING_WRITES);
    expect(svc.pending.size).toBe(0);
  });

  test("kill switch SC2TOOLS_GUIDE_SAMPLES_DISABLED=1 stops capture and writes", async () => {
    const prev = process.env.SC2TOOLS_GUIDE_SAMPLES_DISABLED;
    process.env.SC2TOOLS_GUIDE_SAMPLES_DISABLED = "1";
    try {
      const db = fakeDb();
      const svc = new GuideSamplesService(db, { pepper: PEPPER, logger: silentLogger() });
      svc.capture("u_1", ingestGame());
      await svc.drain();
      expect(await svc.writeSample("u_1", "g", extractSample(ingestGame()))).toBe(false);
      expect(db.guideSamples.updateOne).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.SC2TOOLS_GUIDE_SAMPLES_DISABLED;
      else process.env.SC2TOOLS_GUIDE_SAMPLES_DISABLED = prev;
    }
  });

  test("a re-upload relabelled to a non-guide build removes its stale sample", async () => {
    const db = fakeDb();
    const svc = new GuideSamplesService(db, { pepper: PEPPER, logger: silentLogger(), disabled: false });
    const key = { userHash: guideUserHash(PEPPER, "u_1"), gameHash: guideGameHash(PEPPER, "u_1", "g-relabel") };
    svc.capture("u_1", ingestGame({ gameId: "g-relabel", myBuild: "My private build" }), { created: false });
    await svc.drain();
    expect(db.guideSamples.deleteOne).toHaveBeenCalledTimes(1);
    expect(db.guideSamples.deleteOne).toHaveBeenCalledWith(key);
    expect(svc.counters).toEqual({ captured: 0, skipped: 1, failed: 0, dropped: 0 });
    expect(JSON.stringify(db.guideSamples.deleteOne.mock.calls)).not.toContain("u_1");
  });

  test.each([
    ["a brand-new game", ingestGame({ myBuild: "My private build" }), { created: true }],
    ["an unknown upload outcome", ingestGame({ myBuild: "My private build" }), undefined],
    ["a sparser re-upload (no build label)", ingestGame({ myBuild: undefined }), { created: false }],
    ["a re-upload skipped for another reason", ingestGame({ isLadderGame: false }), { created: false }],
    ["a re-upload without a build log", ingestGame({ buildLog: undefined }), { created: false }],
  ])("never removes a sample for %s", async (_label, game, opts) => {
    const db = fakeDb();
    const svc = new GuideSamplesService(db, { pepper: PEPPER, logger: silentLogger(), disabled: false });
    svc.capture("u_1", game, opts);
    await svc.drain();
    expect(db.guideSamples.deleteOne).not.toHaveBeenCalled();
    expect(db.guideSamples.updateOne).not.toHaveBeenCalled();
    expect(svc.counters.skipped).toBe(1);
  });

  test("a failing stale-sample delete is counted, never thrown", async () => {
    const db = fakeDb({ deleteOne: async () => { throw Object.assign(new Error("down"), { code: 91 }); } });
    const svc = new GuideSamplesService(db, { pepper: PEPPER, logger: silentLogger(), disabled: false });
    expect(() => svc.capture("u_1", ingestGame({ myBuild: "PvZ - Game Too Short" }), { created: false })).not.toThrow();
    await svc.drain();
    expect(svc.counters).toEqual({ captured: 0, skipped: 1, failed: 1, dropped: 0 });
  });

  test("removeSample deletes exactly one game's sample by its hashed key", async () => {
    const db = fakeDb();
    const svc = new GuideSamplesService(db, { pepper: PEPPER, logger: null, disabled: false });
    expect(await svc.removeSample("u_1", "g1")).toBe(1);
    expect(db.guideSamples.deleteOne).toHaveBeenCalledWith({
      userHash: guideUserHash(PEPPER, "u_1"),
      gameHash: guideGameHash(PEPPER, "u_1", "g1"),
    });
  });

  test("GDPR helpers delete by user hash and by hashed game ids", async () => {
    const db = fakeDb();
    const svc = new GuideSamplesService(db, { pepper: PEPPER, logger: null, disabled: false });
    expect(await svc.deleteForUser("u_1")).toBe(2);
    expect(db.guideSamples.deleteMany).toHaveBeenLastCalledWith({ userHash: guideUserHash(PEPPER, "u_1") });
    expect(await svc.deleteForGames("u_1", ["g1", "", null, "g2"])).toBe(2);
    expect(db.guideSamples.deleteMany).toHaveBeenLastCalledWith({
      userHash: guideUserHash(PEPPER, "u_1"),
      gameHash: { $in: [guideGameHash(PEPPER, "u_1", "g1"), guideGameHash(PEPPER, "u_1", "g2")] },
    });
    expect(svc.userHash("u_1")).toBe(guideUserHash(PEPPER, "u_1"));
  });

  test("requires the pepper", () => {
    expect(() => new GuideSamplesService(fakeDb(), {})).toThrow(TypeError);
  });

  test("hashes are domain-separated and deterministic", () => {
    expect(guideUserHash(PEPPER, "a")).toMatch(/^[0-9a-f]{64}$/);
    expect(guideUserHash(PEPPER, "a")).toBe(guideUserHash(PEPPER, "a"));
    expect(guideGameHash(PEPPER, "ab", "c")).not.toBe(guideGameHash(PEPPER, "a", "bc"));
    expect(guideGameHash(PEPPER, "a", "b")).not.toBe(guideUserHash(PEPPER, "a\0b"));
  });
});

describe("ingest budget", () => {
  /** A realistic worst case: 5000 build-log lines (units included) + 5000 timeline samples. */
  function heavyGame() {
    const names = ["Probe", "Pylon", "Gateway", "Assimilator", "Zealot", "Stalker", "Adept", "CyberneticsCore",
      "Nexus", "WarpGateResearch", "TwilightCouncil", "BlinkTech", "Oracle", "Stargate", "Immortal", "Observer",
      "Colossus", "ProtossGroundWeaponsLevel1", "WarpGate", "Forge"];
    const buildLog = [];
    for (let i = 0; i < 5000; i += 1) {
      const t = Math.floor((i * 1500) / 5000);
      buildLog.push(`[${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}] ${names[i % names.length]}`);
    }
    const unitTimeline = [];
    for (let i = 0; i < 5000; i += 1) {
      unitTimeline.push({
        time: Math.floor(i * 0.3),
        my: { Probe: 60, Zealot: 8, Stalker: 12, Adept: 4, Immortal: 3, Colossus: 2, Observer: 1, WarpPrismPhasing: 1, Oracle: 1 },
        opp: { Drone: 70, Zergling: 30, Roach: 20, Overlord: 12 },
      });
    }
    return ingestGame({ buildLog, macroBreakdown: { unit_timeline: unitTimeline }, durationSec: 1500 });
  }

  test("extractSample stays inside the ingest budget on a 5000-line log", () => {
    const game = heavyGame();
    for (let i = 0; i < 3; i += 1) extractSample(game); // warm-up (JIT)
    const runs = [];
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now();
      const sample = extractSample(game);
      runs.push(performance.now() - t0);
      expect(sample.milestones.Pylon).toBeDefined();
    }
    runs.sort((a, b) => a - b);
    const median = runs[Math.floor(runs.length / 2)];
    // Target < 5 ms (measured ~3 ms locally); generous bound for shared CI runners.
    expect(median).toBeLessThan(25);
  });
});
