import { describe, expect, it } from "vitest";
import {
  computeLosses,
  lossValue,
  morphConsumedIndices,
  statsHaveWorkers,
  tradeEfficiency,
  unitCost,
  workerCountAt,
} from "../mapReplayLosses";
import type { PlaybackBuilding, PlaybackUnit } from "../mapReplay";

const unit = (
  owner: "me" | "opp",
  name: string,
  born: number,
  died: number | null,
): PlaybackUnit => ({ owner, name, born, died, wp: [born, 10, 10] });

describe("unitCost", () => {
  it("prices base units from the balance dataset", () => {
    expect(unitCost("Marine")).toEqual({ minerals: 50, gas: 0 });
    expect(unitCost("SiegeTank")).toEqual({ minerals: 150, gas: 125 });
    expect(unitCost("Probe")).toEqual({ minerals: 50, gas: 0 });
  });

  it("prices morphs at full invested cost via the builtFrom chain", () => {
    // Baneling = Zergling (25/0) + morph (25/25).
    expect(unitCost("Baneling")).toEqual({ minerals: 50, gas: 25 });
    // Brood Lord = Corruptor (150/100) + morph (150/150).
    expect(unitCost("BroodLord")).toEqual({ minerals: 300, gas: 250 });
    // Ravager = Roach (75/25) + morph (25/75).
    expect(unitCost("Ravager")).toEqual({ minerals: 100, gas: 100 });
  });

  it("covers canonical names outside the dataset", () => {
    expect(unitCost("Archon")).toEqual({ minerals: 100, gas: 300 });
    expect(unitCost("Hellbat")).toEqual({ minerals: 100, gas: 0 });
  });

  it("returns null for free or unknown units", () => {
    expect(unitCost("MULE")).toBeNull();
    expect(unitCost("Broodling")).toBeNull();
    expect(unitCost("NotARealUnit")).toBeNull();
  });
});

describe("computeLosses", () => {
  const units: PlaybackUnit[] = [
    unit("me", "Marine", 60, 200),
    unit("me", "Marine", 60, 210),
    unit("me", "SCV", 0, 205),
    unit("me", "Marine", 60, null), // survivor — never a loss
    unit("me", "MULE", 100, 164), // free — never a loss
    unit("opp", "Roach", 90, 208),
    unit("opp", "Zergling", 80, 500), // dies after the scrub time
  ];

  it("aggregates deaths up to t with real mineral/gas pricing", () => {
    const losses = computeLosses(units, "me", 300);
    expect(losses.count).toBe(3);
    expect(losses.minerals).toBe(150); // 2×50 Marine + 50 SCV
    expect(losses.gas).toBe(0);
    expect(losses.byUnit).toEqual([
      { name: "Marine", count: 2, minerals: 100, gas: 0 },
      { name: "SCV", count: 1, minerals: 50, gas: 0 },
    ]);
  });

  it("is scrub-time sensitive", () => {
    expect(computeLosses(units, "me", 100).count).toBe(0);
    expect(computeLosses(units, "opp", 300).byUnit).toEqual([
      { name: "Roach", count: 1, minerals: 75, gas: 25 },
    ]);
    expect(computeLosses(units, "opp", 600).count).toBe(2);
  });
});

describe("tradeEfficiency", () => {
  const at = (units: PlaybackUnit[], owner: "me" | "opp", t: number) =>
    computeLosses(units, owner, t);

  it("is killed-value per lost-resource", () => {
    const units = [
      unit("me", "Marine", 0, 100), // I lost 50
      unit("opp", "Roach", 0, 100), // they lost 100
    ];
    const mine = at(units, "me", 200);
    const theirs = at(units, "opp", 200);
    expect(lossValue(mine)).toBe(50);
    expect(lossValue(theirs)).toBe(100);
    expect(tradeEfficiency(mine, theirs)).toBe(2);
    expect(tradeEfficiency(theirs, mine)).toBe(0.5);
  });

  it("handles the nothing-died and one-sided cases", () => {
    const empty = computeLosses([], "me", 100);
    expect(tradeEfficiency(empty, empty)).toBeNull();
    const oneSided = at([unit("opp", "Roach", 0, 50)], "opp", 100);
    expect(tradeEfficiency(empty, oneSided)).toBe(Infinity);
  });
});

describe("morphConsumedIndices", () => {
  const building = (
    owner: "me" | "opp",
    name: string,
    t: number,
    x: number,
    y: number,
  ): PlaybackBuilding => ({ owner, name, t, x, y, moves: [], died: null });

  const at = (
    owner: "me" | "opp",
    name: string,
    born: number,
    died: number | null,
    x: number,
    y: number,
  ): PlaybackUnit => ({ owner, name, born, died, wp: [born, x, y] });

  it("excludes a Drone that morphed into a structure from losses", () => {
    const units = [
      // Dies at the Spawning Pool's init time and spot — that IS the pool.
      at("me", "Drone", 0, 60, 50, 50),
      // Dies mid-map with no building anywhere near — a real loss.
      at("me", "Drone", 0, 90, 120, 120),
    ];
    const buildings = [building("me", "SpawningPool", 60, 51, 50)];
    const consumed = morphConsumedIndices(units, buildings);
    expect([...consumed]).toEqual([0]);
    const losses = computeLosses(units, "me", 200, consumed);
    expect(losses.count).toBe(1);
    expect(losses.minerals).toBe(50);
  });

  it("requires the building to belong to the same owner", () => {
    const units = [at("me", "Drone", 0, 60, 50, 50)];
    const buildings = [building("opp", "SpawningPool", 60, 51, 50)];
    expect(morphConsumedIndices(units, buildings).size).toBe(0);
  });

  it("keeps a Drone shot far from any construction as a loss", () => {
    const units = [at("me", "Drone", 0, 60, 50, 50)];
    // Same second but across the map — not that drone's building.
    const buildings = [building("me", "Hatchery", 60, 150, 150)];
    expect(morphConsumedIndices(units, buildings).size).toBe(0);
  });

  it("excludes Templar merged into an Archon, prices the Archon once", () => {
    const units = [
      at("me", "HighTemplar", 100, 300, 80, 80),
      at("me", "HighTemplar", 100, 300, 81, 80),
      // The Archon born where the templar died; it later dies too.
      at("me", "Archon", 300, 500, 80.5, 80),
      // A templar killed in a fight elsewhere stays a loss.
      at("me", "HighTemplar", 100, 300, 20, 20),
    ];
    const consumed = morphConsumedIndices(units, []);
    expect([...consumed].sort()).toEqual([0, 1]);
    const losses = computeLosses(units, "me", 600, consumed);
    // 1 real templar (50/150) + 1 archon (100/300) — merged pair free.
    expect(losses.count).toBe(2);
    expect(losses.minerals).toBe(150);
    expect(losses.gas).toBe(450);
  });

  it("lets each building consume at most ONE drone death", () => {
    // Two drones die on the same tick near one hatchery — only the
    // closer one is the morph; the other was killed in the same
    // harass and must stay a loss.
    const units = [
      at("me", "Drone", 0, 120, 60, 60),
      at("me", "Drone", 0, 120, 63, 60),
    ];
    const buildings = [building("me", "Hatchery", 120, 60, 60)];
    const consumed = morphConsumedIndices(units, buildings);
    expect([...consumed]).toEqual([0]);
  });

  it("an Archon consumes at most two templar deaths", () => {
    const units = [
      at("me", "HighTemplar", 100, 300, 80, 80),
      at("me", "HighTemplar", 100, 300, 80.5, 80),
      // Third templar sniped in the same fight, right next to the
      // merge — the merge only ate two.
      at("me", "HighTemplar", 100, 300, 81, 80),
      at("me", "Archon", 300, null, 80.2, 80),
    ];
    const consumed = morphConsumedIndices(units, []);
    expect(consumed.size).toBe(2);
  });

  it("trusts exact killer attribution on v4 payloads", () => {
    const spent: PlaybackUnit = { ...at("me", "Drone", 0, 60, 50, 50), sd: true };
    const units = [
      spent,
      // Killed drone standing right where a building starts on the
      // same tick — the heuristic would have paired it; attribution
      // knows better.
      at("me", "Drone", 0, 60, 51, 50),
    ];
    const buildings = [building("me", "SpawningPool", 60, 51, 50)];
    const consumed = morphConsumedIndices(units, buildings, 4);
    expect([...consumed]).toEqual([0]);
    // sd on a free unit name never matters; sd on army names is
    // ignored too — only Drone/Templar deaths can be tech spending.
    const oddball: PlaybackUnit = { ...at("me", "Zealot", 0, 60, 50, 50), sd: true };
    expect(morphConsumedIndices([oddball], [], 4).size).toBe(0);
  });
});

describe("workerCountAt", () => {
  const units: PlaybackUnit[] = [
    unit("me", "SCV", 0, null),
    unit("me", "SCV", 0, 90),
    unit("me", "SCV", 120, null),
    unit("me", "MULE", 30, null), // MULEs aren't workers for the HUD
    unit("me", "Marine", 0, null),
    unit("opp", "Drone", 0, null),
  ];

  it("counts only alive mining workers for the owner", () => {
    expect(workerCountAt(units, "me", 60)).toBe(2);
    expect(workerCountAt(units, "me", 100)).toBe(1);
    expect(workerCountAt(units, "me", 150)).toBe(2);
    expect(workerCountAt(units, "opp", 60)).toBe(1);
  });
});

describe("statsHaveWorkers", () => {
  it("flags the legacy all-zero workers column", () => {
    expect(
      statsHaveWorkers([
        [0, 0, 0, 12],
        [100, 500, 0, 40],
      ]),
    ).toBe(false);
    expect(
      statsHaveWorkers([
        [0, 0, 12, 12],
        [100, 500, 20, 40],
      ]),
    ).toBe(true);
    expect(statsHaveWorkers([])).toBe(false);
  });
});
