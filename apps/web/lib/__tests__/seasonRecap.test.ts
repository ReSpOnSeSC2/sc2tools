import { describe, expect, it } from "vitest";
import {
  computeSeasonRecap,
  resolveRecapWindow,
  MIN_RECAP_GAMES,
} from "../seasonRecap";
import type { ArcadeGame } from "@/components/analyzer/arcade/types";
import { buildRecapSlides } from "@/components/analyzer/arcade/seasonRecapSlides";

function game(over: Partial<ArcadeGame> & { date: string }): ArcadeGame {
  return {
    gameId: over.date + Math.random(),
    result: "Victory",
    ...over,
  } as ArcadeGame;
}

const SINCE = new Date("2026-01-01T00:00:00Z");

describe("computeSeasonRecap", () => {
  it("aggregates totals, winrate, and hours over the window", () => {
    const games: ArcadeGame[] = [
      game({ date: "2026-02-01T10:00:00Z", result: "Victory", duration: 600 }),
      game({ date: "2026-02-02T10:00:00Z", result: "Defeat", duration: 300 }),
      game({ date: "2026-02-03T10:00:00Z", result: "Victory", duration: 900 }),
      // Outside the window — excluded.
      game({ date: "2025-12-31T10:00:00Z", result: "Victory" }),
    ];
    const r = computeSeasonRecap(games, { since: SINCE });
    expect(r.totals.games).toBe(3);
    expect(r.totals.wins).toBe(2);
    expect(r.totals.losses).toBe(1);
    expect(r.totals.winrate).toBeCloseTo(2 / 3, 5);
    expect(r.totals.hoursPlayed).toBeCloseTo(1800 / 3600, 5);
  });

  it("computes MMR journey only with >= 2 mmr points", () => {
    const one = computeSeasonRecap(
      [game({ date: "2026-02-01T10:00:00Z", myMmr: 4000 })],
      { since: SINCE },
    );
    expect(one.mmrJourney).toBeNull();

    const many = computeSeasonRecap(
      [
        game({ date: "2026-02-01T10:00:00Z", myMmr: 4000 }),
        game({ date: "2026-02-02T10:00:00Z", myMmr: 4120 }),
        game({ date: "2026-02-03T10:00:00Z", myMmr: 4080 }),
      ],
      { since: SINCE },
    );
    expect(many.mmrJourney).toEqual({
      start: 4000,
      end: 4080,
      peak: 4120,
      delta: 80,
    });
  });

  it("picks nemesis by losses and best victim by wins", () => {
    const games: ArcadeGame[] = [];
    // Nemesis: lose 3 to Foe.
    for (let i = 0; i < 3; i += 1) {
      games.push(
        game({
          date: `2026-02-0${i + 1}T10:00:00Z`,
          result: "Defeat",
          oppPulseId: "p-foe",
          opponent: { displayName: "Foe" },
        }),
      );
    }
    // Victim: beat Prey twice.
    for (let i = 0; i < 2; i += 1) {
      games.push(
        game({
          date: `2026-02-1${i + 1}T10:00:00Z`,
          result: "Victory",
          oppPulseId: "p-prey",
          opponent: { displayName: "Prey" },
        }),
      );
    }
    const r = computeSeasonRecap(games, { since: SINCE });
    expect(r.nemesis?.name).toBe("Foe");
    expect(r.nemesis?.record).toBe("0-3");
    expect(r.bestVictim?.name).toBe("Prey");
    expect(r.bestVictim?.record).toBe("2-0");
  });

  it("finds the biggest upset (win vs higher MMR)", () => {
    const games: ArcadeGame[] = [
      game({
        date: "2026-02-01T10:00:00Z",
        result: "Victory",
        myMmr: 4000,
        oppMmr: 4300,
        opponent: { displayName: "Higher", mmr: 4300 },
        map: "Alcyone",
      }),
      game({
        date: "2026-02-02T10:00:00Z",
        result: "Victory",
        myMmr: 4000,
        oppMmr: 4100,
      }),
      // A win vs LOWER mmr — not an upset.
      game({ date: "2026-02-03T10:00:00Z", result: "Victory", myMmr: 4000, oppMmr: 3800 }),
    ];
    const r = computeSeasonRecap(games, { since: SINCE });
    expect(r.biggestUpset?.mmrGap).toBe(300);
    expect(r.biggestUpset?.opponentName).toBe("Higher");
    expect(r.biggestUpset?.map).toBe("Alcyone");
  });

  it("degrades to nulls on sparse data without throwing", () => {
    const r = computeSeasonRecap(
      [game({ date: "2026-02-01T10:00:00Z", result: "Victory" })],
      { since: SINCE },
    );
    expect(r.totals.games).toBe(1);
    expect(r.mmrJourney).toBeNull();
    expect(r.nemesis).toBeNull();
    expect(r.biggestUpset).toBeNull();
    expect(r.favoriteMap).toBeNull();
    expect(r.totals.hoursPlayed).toBeNull();
  });

  it("falls back to a 90-day window below the season game floor", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    // Only a couple of recent games -> under MIN_RECAP_GAMES for any
    // season, so the window is days90.
    const games = [
      { date: "2026-06-14T10:00:00Z" },
      { date: "2026-06-13T10:00:00Z" },
    ];
    const w = resolveRecapWindow(games, now);
    expect(w.kind).toBe("days90");
    expect(w.label).toBe("Last 90 days");
  });
});

describe("buildRecapSlides", () => {
  const base = computeSeasonRecap(
    Array.from({ length: 12 }, (_, i) =>
      game({
        date: `2026-02-${String((i % 27) + 1).padStart(2, "0")}T10:00:00Z`,
        result: i % 2 === 0 ? "Victory" : "Defeat",
        myMmr: 4000 + i * 5,
        myBuild: "PvZ - 2 Stargate Void Ray",
        oppRace: "Z",
        map: "Alcyone",
      }),
    ),
    { since: SINCE },
  );
  const window = { since: SINCE, label: "Season 67", kind: "season" as const };

  it("always starts with an intro and ends with a share slide", () => {
    const slides = buildRecapSlides(base, window);
    expect(slides[0].key).toBe("intro");
    expect(slides[slides.length - 1].key).toBe("share");
    expect(slides.length).toBeGreaterThanOrEqual(3);
  });

  it("skips null sections rather than rendering empty slides", () => {
    const sparse = computeSeasonRecap(
      Array.from({ length: 10 }, (_, i) => game({ date: `2026-02-0${(i % 9) + 1}T10:00:00Z` })),
      { since: SINCE },
    );
    const slides = buildRecapSlides(sparse, window);
    // No MMR, no opponents, no map -> only intro, totals, share.
    const keys = slides.map((s) => s.key);
    expect(keys).not.toContain("mmr");
    expect(keys).not.toContain("nemesis");
    expect(keys).toContain("totals");
    expect(keys[0]).toBe("intro");
    expect(keys[keys.length - 1]).toBe("share");
  });

  it("includes MMR and opener slides when the data is present", () => {
    const slides = buildRecapSlides(base, window);
    const keys = slides.map((s) => s.key);
    expect(keys).toContain("mmr");
    expect(keys).toContain("opener");
  });
});

describe("MIN_RECAP_GAMES", () => {
  it("is the documented unlock threshold", () => {
    expect(MIN_RECAP_GAMES).toBe(10);
  });
});
