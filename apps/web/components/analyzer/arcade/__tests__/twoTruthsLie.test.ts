import { describe, expect, test } from "vitest";
import { buildFactPool } from "../modes/games/twoTruthsLie";
import { twoTruthsLie } from "../modes/games/twoTruthsLie";
import { mulberry32 } from "../ArcadeEngine";
import type { ArcadeDataset, ArcadeGame } from "../types";

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

const game = (over: Partial<ArcadeGame> = {}): ArcadeGame => ({
  gameId: "g",
  date: "2026-05-01T12:00:00Z",
  result: "Win",
  duration: 600,
  myRace: "P",
  oppRace: "T",
  ...over,
});

describe("Two Truths & a Lie — claim text never says 'undefined'", () => {
  test("map facts drop rows whose name is null/empty/whitespace", () => {
    const dataset: ArcadeDataset = {
      ...baseDataset,
      maps: [
        // The pollutants: null + empty + whitespace map names.
        { map: null as unknown as string, wins: 3, losses: 2, total: 5, winRate: 0.6 },
        { map: "", wins: 3, losses: 2, total: 5, winRate: 0.6 },
        { map: "   ", wins: 3, losses: 2, total: 5, winRate: 0.6 },
        // Real rows that should drive the claim.
        { map: "Equilibrium", wins: 6, losses: 2, total: 8, winRate: 0.75 },
        { map: "Goldenaura", wins: 2, losses: 6, total: 8, winRate: 0.25 },
      ],
    };
    const facts = buildFactPool(dataset);
    for (const f of facts) {
      expect(f.truthText.toLowerCase()).not.toContain("undefined");
      expect(f.lieText.toLowerCase()).not.toContain("undefined");
      expect(f.detail.toLowerCase()).not.toContain("undefined");
    }
    // The valid pair should still produce a real map fact.
    const mapFact = facts.find((f) => f.truthText.includes("higher WR on"));
    expect(mapFact).toBeDefined();
    expect(mapFact!.truthText).toContain("Equilibrium");
    expect(mapFact!.truthText).toContain("Goldenaura");
  });

  test("degenerate single-map case (best === worst) does not emit a claim", () => {
    const dataset: ArcadeDataset = {
      ...baseDataset,
      maps: [
        { map: "", wins: 3, losses: 2, total: 5, winRate: 0.6 },
        { map: "Equilibrium", wins: 4, losses: 1, total: 5, winRate: 0.8 },
      ],
    };
    const facts = buildFactPool(dataset);
    // Filter keeps one valid map => no best/worst pair to compare.
    const mapFact = facts.find((f) => f.truthText.includes("higher WR on"));
    expect(mapFact).toBeUndefined();
  });

  test("build fact ignores builds with no name", () => {
    const dataset: ArcadeDataset = {
      ...baseDataset,
      builds: [
        // Empty-name pollutant with a larger plays count must not win.
        { name: "", total: 100, wins: 50, losses: 50, winRate: 0.5 },
        { name: "Reaper FE", total: 8, wins: 6, losses: 2, winRate: 0.75 },
      ],
      summary: { totalGames: 8, wins: 6, losses: 2, winRate: 0.75 },
    };
    const facts = buildFactPool(dataset);
    for (const f of facts) {
      expect(f.truthText.toLowerCase()).not.toContain("undefined");
    }
    const buildFact = facts.find((f) => f.truthText.includes("most-played build"));
    expect(buildFact?.truthText).toContain("Reaper FE");
  });
});

describe("Two Truths & a Lie — generate gate", () => {
  test("rejects below 25-game floor", async () => {
    const dataset: ArcadeDataset = { ...baseDataset, games: [game()] };
    const out = await twoTruthsLie.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-10",
      tz: "UTC",
      data: dataset,
    });
    expect(out.ok).toBe(false);
  });
});
