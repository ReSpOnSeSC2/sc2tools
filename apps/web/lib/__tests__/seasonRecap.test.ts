import { describe, expect, it } from "vitest";
import {
  computeSeasonRecap,
  resolveRecapWindow,
  MIN_RECAP_GAMES,
} from "../seasonRecap";
import type { ArcadeGame } from "@/components/analyzer/arcade/types";
import { buildRecapSlides } from "@/components/analyzer/arcade/seasonRecapSlides";
import type { LogicalSeason } from "../useSeasons";

function game(over: Partial<ArcadeGame> & { date: string }): ArcadeGame {
  return {
    gameId: over.date + Math.random(),
    result: "Victory",
    myToonHandle: "1-S2-1-267727",
    ...over,
  } as ArcadeGame;
}

const SINCE = new Date("2026-01-01T00:00:00Z");
const NA_MAIN = "1-S2-1-267727";
const NA_ALT = "1-S2-1-13835879";
const EU_MAIN = "2-S2-1-8780508";
const JULY_12_2026 = new Date("2026-07-12T16:00:00.000Z");
const CURRENT_SEASON_67: LogicalSeason = {
  number: 67,
  battlenetId: 67,
  year: 2026,
  numberInYear: 2,
  start: "2026-04-01T00:00:00.000Z",
  end: null,
  isCurrent: true,
};

function aprilThroughJulyGames(): Array<{ date: string }> {
  return [
    "2026-04-01T12:00:00.000Z",
    "2026-04-15T12:00:00.000Z",
    "2026-05-01T12:00:00.000Z",
    "2026-05-15T12:00:00.000Z",
    "2026-06-01T12:00:00.000Z",
    "2026-06-15T12:00:00.000Z",
    "2026-07-01T12:00:00.000Z",
    "2026-07-05T12:00:00.000Z",
    "2026-07-10T12:00:00.000Z",
    "2026-07-12T12:00:00.000Z",
  ].map((date) => ({ date }));
}

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

  it("computes an account MMR journey only with >= 2 mmr points", () => {
    const one = computeSeasonRecap(
      [game({ date: "2026-02-01T10:00:00Z", myMmr: 4000 })],
      { since: SINCE },
    );
    expect(one.mmrJourneys).toEqual([]);

    const many = computeSeasonRecap(
      [
        game({ date: "2026-02-01T10:00:00Z", myMmr: 4000 }),
        game({ date: "2026-02-02T10:00:00Z", myMmr: 4120 }),
        game({ date: "2026-02-03T10:00:00Z", myMmr: 4080 }),
      ],
      { since: SINCE },
    );
    expect(many.mmrJourneys).toEqual([
      {
        toonHandle: NA_MAIN,
        region: "NA",
        accountLabel: "NA 267727",
        start: 4000,
        end: 4080,
        peak: 4120,
        delta: 80,
      },
    ]);
  });

  it("keeps interleaved NA and EU MMR histories separate", () => {
    const recap = computeSeasonRecap(
      [
        game({ date: "2026-02-01T10:00:00Z", myToonHandle: NA_MAIN, myMmr: 4000 }),
        game({ date: "2026-02-02T10:00:00Z", myToonHandle: EU_MAIN, myMmr: 5200 }),
        game({ date: "2026-02-03T10:00:00Z", myToonHandle: NA_MAIN, myMmr: 4120 }),
        game({ date: "2026-02-04T10:00:00Z", myToonHandle: EU_MAIN, myMmr: 5180 }),
        game({ date: "2026-02-05T10:00:00Z", myToonHandle: NA_MAIN, myMmr: 4080 }),
        game({ date: "2026-02-06T10:00:00Z", myToonHandle: EU_MAIN, myMmr: 5250 }),
      ],
      { since: SINCE },
    );

    expect(recap.mmrJourneys).toEqual([
      {
        toonHandle: NA_MAIN,
        region: "NA",
        accountLabel: "NA 267727",
        start: 4000,
        end: 4080,
        peak: 4120,
        delta: 80,
      },
      {
        toonHandle: EU_MAIN,
        region: "EU",
        accountLabel: "EU 8780508",
        start: 5200,
        end: 5250,
        peak: 5250,
        delta: 50,
      },
    ]);
  });

  it("keeps two accounts in the same region separate", () => {
    const recap = computeSeasonRecap(
      [
        game({ date: "2026-02-01T10:00:00Z", myToonHandle: NA_MAIN, myMmr: 5000 }),
        game({ date: "2026-02-02T10:00:00Z", myToonHandle: NA_ALT, myMmr: 4500 }),
        game({ date: "2026-02-03T10:00:00Z", myToonHandle: NA_MAIN, myMmr: 5100 }),
        game({ date: "2026-02-04T10:00:00Z", myToonHandle: NA_ALT, myMmr: 4400 }),
      ],
      { since: SINCE },
    );

    expect(recap.mmrJourneys.map((journey) => journey.accountLabel)).toEqual([
      "NA 13835879",
      "NA 267727",
    ]);
    expect(recap.mmrJourneys.find((journey) => journey.toonHandle === NA_MAIN)).toMatchObject({
      start: 5000,
      end: 5100,
      delta: 100,
    });
    expect(recap.mmrJourneys.find((journey) => journey.toonHandle === NA_ALT)).toMatchObject({
      start: 4500,
      end: 4400,
      delta: -100,
    });
  });

  it("omits every account that has only one MMR point", () => {
    const recap = computeSeasonRecap(
      [
        game({ date: "2026-02-01T10:00:00Z", myToonHandle: NA_MAIN, myMmr: 5000 }),
        game({ date: "2026-02-02T10:00:00Z", myToonHandle: EU_MAIN, myMmr: 4500 }),
      ],
      { since: SINCE },
    );

    expect(recap.mmrJourneys).toEqual([]);
  });

  it("omits handle-less MMR rather than combining unknown accounts", () => {
    const recap = computeSeasonRecap(
      [
        game({ date: "2026-02-01T10:00:00Z", myToonHandle: null, myMmr: 5400 }),
        game({ date: "2026-02-02T10:00:00Z", myToonHandle: null, myMmr: 5220 }),
      ],
      { since: SINCE },
    );

    expect(recap.mmrJourneys).toEqual([]);
  });

  it("labels an exact account with an unknown region without merging it", () => {
    const recap = computeSeasonRecap(
      [
        game({ date: "2026-02-01T10:00:00Z", myToonHandle: "4-S2-1-30230", myMmr: 5200 }),
        game({ date: "2026-02-02T10:00:00Z", myToonHandle: "4-S2-1-30230", myMmr: 5220 }),
      ],
      { since: SINCE },
    );

    expect(recap.mmrJourneys[0]).toMatchObject({
      toonHandle: "4-S2-1-30230",
      region: null,
      accountLabel: "?? 30230",
      delta: 20,
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
    expect(r.mmrJourneys).toEqual([]);
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

  it("uses the authoritative current Season 67 label and start", () => {
    const authoritativeStart = "2026-04-09T05:00:00.000Z";
    const season = { ...CURRENT_SEASON_67, start: authoritativeStart };
    const games = Array.from({ length: MIN_RECAP_GAMES }, (_, index) => ({
      date: `2026-05-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
    }));

    const window = resolveRecapWindow(games, JULY_12_2026, [season]);

    expect(window).toEqual({
      since: new Date(authoritativeStart),
      label: "Season 67",
      kind: "season",
    });
  });

  it("uses the frozen Season 67 fallback when the catalog is empty", () => {
    const window = resolveRecapWindow(
      aprilThroughJulyGames(),
      JULY_12_2026,
      [],
    );

    expect(window.kind).toBe("season");
    expect(window.label).toBe("Season 67");
    expect(window.since.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("keeps the full April-through-July Season 67 scope", () => {
    const games = [
      { date: "2026-03-31T23:59:59.000Z" },
      ...aprilThroughJulyGames(),
    ];
    const window = resolveRecapWindow(
      games,
      JULY_12_2026,
      [CURRENT_SEASON_67],
    );
    const recap = computeSeasonRecap(
      games.map((row) => game({ date: row.date })),
      { since: window.since, until: JULY_12_2026 },
    );

    expect(window.label).toBe("Season 67");
    expect(recap.totals.games).toBe(10);
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
    expect(keys.some((key) => key.startsWith("mmr:"))).toBe(false);
    expect(keys).not.toContain("nemesis");
    expect(keys).toContain("totals");
    expect(keys[0]).toBe("intro");
    expect(keys[keys.length - 1]).toBe("share");
  });

  it("includes MMR and opener slides when the data is present", () => {
    const slides = buildRecapSlides(base, window);
    const keys = slides.map((s) => s.key);
    expect(keys).toContain(`mmr:${NA_MAIN}`);
    expect(keys).toContain("opener");
  });

  it("creates a clearly account-labeled slide for each MMR journey", () => {
    const multiAccount = computeSeasonRecap(
      [
        game({ date: "2026-02-01T10:00:00Z", myToonHandle: EU_MAIN, myMmr: 5200 }),
        game({ date: "2026-02-02T10:00:00Z", myToonHandle: NA_MAIN, myMmr: 4000 }),
        game({ date: "2026-02-03T10:00:00Z", myToonHandle: EU_MAIN, myMmr: 5250 }),
        game({ date: "2026-02-04T10:00:00Z", myToonHandle: NA_MAIN, myMmr: 4100 }),
      ],
      { since: SINCE },
    );

    const mmrSlides = buildRecapSlides(multiAccount, window).filter((slide) =>
      slide.key.startsWith("mmr:"),
    );
    expect(mmrSlides).toEqual([
      expect.objectContaining({
        key: `mmr:${NA_MAIN}`,
        eyebrow: "MMR journey · NA 267727",
        big: "+100",
      }),
      expect.objectContaining({
        key: `mmr:${EU_MAIN}`,
        eyebrow: "MMR journey · EU 8780508",
        big: "+50",
      }),
    ]);
  });
});

describe("MIN_RECAP_GAMES", () => {
  it("is the documented unlock threshold", () => {
    expect(MIN_RECAP_GAMES).toBe(10);
  });
});
