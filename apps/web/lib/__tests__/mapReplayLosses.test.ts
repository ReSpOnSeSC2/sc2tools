import { describe, expect, it } from "vitest";
import {
  computeLosses,
  lossValue,
  statsHaveWorkers,
  tradeEfficiency,
  unitCost,
  workerCountAt,
} from "../mapReplayLosses";
import type { PlaybackUnit } from "../mapReplay";

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
