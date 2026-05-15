// @ts-nocheck
"use strict";

const {
  SnapshotTechPathService,
  wilsonCI,
  buildTickResponse,
} = require("../src/services/snapshotTechPath");
const {
  pathSignature,
  pathLabel,
  pathIdFromSignature,
  filterToDecisionBuildings,
  PATH_ALIASES,
} = require("../src/services/snapshotTechPathLabels");

describe("snapshotTechPathLabels", () => {
  test("pathSignature is order-insensitive", () => {
    expect(pathSignature(["RoboticsFacility", "TwilightCouncil"]))
      .toBe(pathSignature(["TwilightCouncil", "RoboticsFacility"]));
  });

  test("pathLabel resolves common aliases", () => {
    expect(pathLabel(["TwilightCouncil", "RoboticsFacility"], "P")).toBe("Twilight + Robo");
    expect(pathLabel(["Stargate", "FleetBeacon"], "P")).toBe("Skytoss");
  });

  test("pathLabel falls back to race-prefixed list for unknown sets", () => {
    const label = pathLabel(["TwilightCouncil", "RoboticsFacility", "Stargate"], "P");
    expect(label).toBe("Triple-tech (Pro all-three)"); // alias hit
  });

  test("pathLabel uses fallback for novel paths", () => {
    const label = pathLabel(["DarkShrine", "FleetBeacon"], "P");
    expect(label).toContain("Protoss");
    expect(label).toContain("DarkShrine");
  });

  test("pathIdFromSignature is URL-safe snake_case", () => {
    const id = pathIdFromSignature(pathSignature(["TwilightCouncil", "RoboticsFacility"]));
    expect(id).toBe("robotics_facility__twilight_council");
  });

  test("filterToDecisionBuildings drops universal prereqs", () => {
    const filtered = filterToDecisionBuildings(
      ["Forge", "TwilightCouncil", "CyberneticsCore", "Stargate"],
      "P",
    );
    expect(filtered.sort()).toEqual(["Stargate", "TwilightCouncil"]);
  });
});

describe("SnapshotTechPathService.parseDecisionBuildings", () => {
  const svc = new SnapshotTechPathService();

  test("parses [m:ss] lines into first-seen times", () => {
    const log = [
      "[1:30] Pylon",
      "[3:15] TwilightCouncil",
      "[4:00] RoboticsFacility",
      "[5:00] TwilightCouncil", // duplicate — should be ignored
    ];
    const out = svc.parseDecisionBuildings(log, "P");
    expect(out.get("TwilightCouncil")).toBe(3 * 60 + 15);
    expect(out.get("RoboticsFacility")).toBe(4 * 60);
    expect(out.has("Pylon")).toBe(false);
  });

  test("returns empty when race is unknown", () => {
    expect(svc.parseDecisionBuildings([], null).size).toBe(0);
  });
});

describe("SnapshotTechPathService.computePathStatsAtTick", () => {
  test("aggregates per-path win/loss counts across cohort", () => {
    const svc = new SnapshotTechPathService();
    const games = [];
    const details = new Map();
    for (let i = 0; i < 6; i += 1) {
      games.push({ userId: "u1", gameId: `g${i}`, result: "Victory", myRace: "Protoss" });
      details.set(`u1:g${i}`, { buildLog: ["[3:00] TwilightCouncil", "[4:00] RoboticsFacility"] });
    }
    for (let i = 0; i < 4; i += 1) {
      games.push({ userId: "u1", gameId: `l${i}`, result: "Defeat", myRace: "Protoss" });
      details.set(`u1:l${i}`, { buildLog: ["[3:00] Stargate"] });
    }
    const stats = svc.computePathStatsAtTick(games, details, 360);
    const twilightRobo = stats.find((s) => s.signature === "RoboticsFacility|TwilightCouncil");
    expect(twilightRobo.wins).toBe(6);
    expect(twilightRobo.losses).toBe(0);
    expect(twilightRobo.winRate).toBe(1);
    const stargate = stats.find((s) => s.signature === "Stargate");
    expect(stargate.losses).toBe(4);
  });
});

describe("buildTickResponse", () => {
  test("returns focal path, alternatives, and transitions", () => {
    const svc = new SnapshotTechPathService();
    const games = [];
    const details = new Map();
    for (let i = 0; i < 6; i += 1) {
      games.push({ userId: "u1", gameId: `w${i}`, result: "Victory", myRace: "Protoss" });
      details.set(`u1:w${i}`, {
        buildLog: ["[3:00] TwilightCouncil", "[5:00] RoboticsFacility", "[7:30] TemplarArchive"],
      });
    }
    for (let i = 0; i < 6; i += 1) {
      games.push({ userId: "u1", gameId: `l${i}`, result: "Defeat", myRace: "Protoss" });
      details.set(`u1:l${i}`, { buildLog: ["[3:00] Stargate"] });
    }
    const out = buildTickResponse(
      svc,
      { buildLog: ["[3:00] TwilightCouncil"], race: "P" },
      games,
      details,
      330,
    );
    expect(out.buildingsInPath).toEqual(["TwilightCouncil"]);
    expect(out.pathLabel).toBeDefined();
    expect(Array.isArray(out.alternatives)).toBe(true);
  });
});

describe("wilsonCI", () => {
  test("returns [0, 0] for zero samples", () => {
    expect(wilsonCI(0, 0)).toEqual([0, 0]);
  });

  test("centers near observed proportion at large N", () => {
    const [lo, hi] = wilsonCI(70, 100);
    expect(lo).toBeGreaterThan(0.6);
    expect(hi).toBeLessThan(0.8);
  });

  test("CI widens at small N", () => {
    const [lo, hi] = wilsonCI(7, 10);
    expect(hi - lo).toBeGreaterThan(0.3);
  });
});

describe("scoreFromWinRate", () => {
  test("0.5 → 0", () => {
    expect(new SnapshotTechPathService().scoreFromWinRate(0.5)).toBe(0);
  });
  test("0.7 → +2", () => {
    expect(new SnapshotTechPathService().scoreFromWinRate(0.7)).toBeCloseTo(2, 5);
  });
  test("0.3 → -2", () => {
    expect(new SnapshotTechPathService().scoreFromWinRate(0.3)).toBeCloseTo(-2, 5);
  });
  test("non-finite → 0", () => {
    expect(new SnapshotTechPathService().scoreFromWinRate(NaN)).toBe(0);
  });
});
