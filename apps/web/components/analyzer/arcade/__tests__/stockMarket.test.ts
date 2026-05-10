import { describe, expect, test } from "vitest";
import {
  attackForBuild,
  buildUniverse,
  defenseFor,
  isFoil,
  rolling14DayWr,
} from "../sessions";
import type { ArcadeDataset } from "../types";

const baseDataset: ArcadeDataset = {
  games: [],
  opponents: [],
  builds: [],
  customBuilds: [],
  communityBuilds: [],
  matchups: [],
  maps: [],
  summary: null,
  mapPool: [],
};

describe("Stock Market: build universe + price math", () => {
  test("universe is the union of own + eligible community builds (joined by name)", () => {
    const dataset: ArcadeDataset = {
      ...baseDataset,
      builds: [{ name: "Reaper FE", total: 12, wins: 8, losses: 4, winRate: 0.67 }],
      communityBuilds: [
        { slug: "reaper-fe", title: "Reaper FE", race: "T", votes: 12 },
        { slug: "stargate-opener", title: "Stargate Opener", race: "P", votes: 9 }, // never played
      ],
      customBuilds: [{ slug: "my-special", name: "Reaper FE", race: "T", vsRace: "Z" }],
    };
    const u = buildUniverse(dataset);
    // "Reaper FE" comes through once via /v1/builds; not duplicated by community
    // or custom. "Stargate Opener" is excluded because the user never played it.
    expect(u.map((b) => b.name)).toEqual(["Reaper FE"]);
  });

  test("rolling14DayWr returns null below 3 plays in window", () => {
    const now = new Date("2026-05-10T00:00:00Z");
    const dataset: ArcadeDataset = {
      ...baseDataset,
      games: [
        { gameId: "g1", date: "2026-05-09T00:00:00Z", result: "Win", myBuild: "X" },
        { gameId: "g2", date: "2026-05-09T00:00:00Z", result: "Win", myBuild: "X" },
      ],
    };
    expect(rolling14DayWr("X", dataset, now)).toBeNull();
  });

  test("rolling14DayWr ignores games outside the window", () => {
    const now = new Date("2026-05-10T00:00:00Z");
    const dataset: ArcadeDataset = {
      ...baseDataset,
      games: [
        { gameId: "1", date: "2026-04-01T00:00:00Z", result: "Win", myBuild: "X" }, // outside window
        { gameId: "2", date: "2026-05-09T00:00:00Z", result: "Win", myBuild: "X" },
        { gameId: "3", date: "2026-05-09T00:00:00Z", result: "Win", myBuild: "X" },
        { gameId: "4", date: "2026-05-09T00:00:00Z", result: "Loss", myBuild: "X" },
      ],
    };
    expect(rolling14DayWr("X", dataset, now)).toBeCloseTo(2 / 3, 5);
  });

  test("attack/defense/foil derivations are within bounds and sensible", () => {
    const dataset: ArcadeDataset = {
      ...baseDataset,
      builds: [{ name: "Y", total: 20, wins: 14, losses: 6, winRate: 0.7 }],
      games: [
        { gameId: "1", date: "2026-05-09T00:00:00Z", result: "Win", myBuild: "Y", duration: 600 },
        { gameId: "2", date: "2026-05-09T00:00:00Z", result: "Win", myBuild: "Y", duration: 720 },
      ],
    };
    expect(attackForBuild(dataset.builds[0])).toBe(70);
    expect(defenseFor("Y", dataset)).toBe(11); // round((660)/60) = 11
    expect(isFoil("Y", dataset)).toBe(true);
  });
});

/** Pure portfolio P&L helper — replicates the reveal math the surface uses. */
export function portfolioPnl(
  picks: Array<{ slug: string; alloc: number; entryPrice: number }>,
  pricesNow: Record<string, number>,
): number {
  let pnl = 0;
  for (const p of picks) {
    const cur = pricesNow[p.slug];
    if (typeof cur !== "number") continue;
    pnl += (p.alloc / 100) * (cur - p.entryPrice);
  }
  return pnl;
}

describe("Stock Market portfolio P&L", () => {
  test("adds weighted Δprice across picks", () => {
    const pnl = portfolioPnl(
      [
        { slug: "A", alloc: 50, entryPrice: 50 },
        { slug: "B", alloc: 50, entryPrice: 60 },
      ],
      { A: 60, B: 50 },
    );
    expect(pnl).toBe(0); // +5 - 5 = 0
  });
  test("missing prices are skipped, not zeroed", () => {
    expect(
      portfolioPnl([{ slug: "A", alloc: 100, entryPrice: 50 }], {}),
    ).toBe(0);
  });
});
