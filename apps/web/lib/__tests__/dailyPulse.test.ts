// Daily Pulse — deterministic fresh-content selection over the user's
// real games. Fixtures follow the conventions of dailyQuests.test.ts:
// every scenario builds a tiny corpus and asserts exact card outcomes.

import { describe, expect, test } from "vitest";
import type { ArcadeGame } from "@/components/analyzer/arcade/types";
import {
  BOUNCE_BACK_MIN_SAMPLES,
  CLIMB_MIN_DELTA,
  DAILY_PULSE_COUNT,
  MAP_EDGE_MIN_DECIDED,
  MATCHUP_MIN_CAREER_DECIDED,
  MILESTONE_GAMES_WITHIN,
  NEMESIS_MIN_DECIDED,
  PEAK_MIN_RATED,
  PULSE_POOL,
  RISING_BUILD_MIN_CAREER_DECIDED,
  RISING_BUILD_MIN_RECENT_DECIDED,
  RUSTY_BUILD_MIN_DECIDED,
  SESSION_MIN_GAMES,
  STREAK_MIN,
  TIMELY_MAX,
  buildPulseContext,
  netMmrOf,
  selectDailyPulse,
  shiftDateKey,
  shortAccountLabel,
} from "@/lib/dailyPulse";

/** The fixed "today" all fixtures anchor on. */
const DAY = "2026-07-18";
const TZ = "UTC";

let seq = 0;
function game(overrides: Partial<ArcadeGame> = {}): ArcadeGame {
  seq += 1;
  return {
    gameId: `g${seq}`,
    date: "2026-07-10T12:00:00Z",
    result: "Victory",
    ...overrides,
  };
}

/** N decided games spread one per day ending `endDaysAgo` days before DAY. */
function spread(
  n: number,
  endDaysAgo: number,
  make: (i: number) => Partial<ArcadeGame>,
): ArcadeGame[] {
  const anchor = Date.parse(`${DAY}T00:00:00Z`);
  const out: ArcadeGame[] = [];
  for (let i = 0; i < n; i++) {
    const t = anchor - (endDaysAgo + (n - 1 - i)) * 24 * 60 * 60 * 1000;
    out.push(
      game({
        date: new Date(t + 12 * 60 * 60 * 1000).toISOString(),
        ...make(i),
      }),
    );
  }
  return out;
}

/* ──────────────── helpers ──────────────── */

describe("helpers", () => {
  test("shiftDateKey moves whole days and survives bad input", () => {
    expect(shiftDateKey("2026-07-18", -1)).toBe("2026-07-17");
    expect(shiftDateKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDateKey("2026-07-18", -365)).toBe("2025-07-18");
    expect(shiftDateKey("garbage", -1)).toBe("garbage");
  });

  test("shortAccountLabel mirrors the server's chart legend format", () => {
    expect(shortAccountLabel("1-S2-1-12345")).toBe("NA 12345");
    expect(shortAccountLabel("2-S2-1-267727")).toBe("EU 267727");
    expect(shortAccountLabel("3-S2-1-9")).toBe("KR 9");
    expect(shortAccountLabel("9-S2-1-1")).toBe("?? 1");
    expect(shortAccountLabel("")).toBe("Unknown");
  });

  test("netMmrOf sums per-account deltas and never mixes ladders", () => {
    const rows = [
      game({ myToonHandle: "1-S2-1-1", myMmr: 4000 }),
      game({ myToonHandle: "2-S2-1-2", myMmr: 3000 }),
      game({ myToonHandle: "1-S2-1-1", myMmr: 4040 }),
      game({ myToonHandle: "2-S2-1-2", myMmr: 2980 }),
    ];
    // NA: +40, EU: −20 → +20. A naive last−first would report −1020.
    expect(netMmrOf(rows)).toBe(20);
  });

  test("netMmrOf is null when no account has two rated rows", () => {
    expect(netMmrOf([game({ myMmr: 4000 })])).toBeNull();
    expect(
      netMmrOf([
        game({ myToonHandle: "1-S2-1-1", myMmr: 4000 }),
        game({ myToonHandle: "2-S2-1-2", myMmr: 3000 }),
      ]),
    ).toBeNull();
  });
});

/* ──────────────── context builder ──────────────── */

describe("buildPulseContext", () => {
  test("empty corpus produces a fully-null context and zero cards", () => {
    const ctx = buildPulseContext([], DAY, TZ);
    expect(ctx.totalGames).toBe(0);
    expect(ctx.yesterday).toBeNull();
    expect(ctx.mainAccount).toBeNull();
    expect(ctx.risingBuild).toBeNull();
    expect(ctx.nemesis).toBeNull();
    expect(ctx.throwback).toBeNull();
    const sel = selectDailyPulse(DAY, [], { userId: "u1", tz: TZ });
    expect(sel.cards).toEqual([]);
  });

  test("yesterday recap needs the session minimum and reports net MMR", () => {
    const y = shiftDateKey(DAY, -1);
    const single = [game({ date: `${y}T18:00:00Z` })];
    expect(buildPulseContext(single, DAY, TZ).yesterday).toBeNull();

    const rows = [
      game({ date: `${y}T18:00:00Z`, myToonHandle: "1-S2-1-1", myMmr: 4000 }),
      game({
        date: `${y}T19:00:00Z`,
        result: "Defeat",
        myToonHandle: "1-S2-1-1",
        myMmr: 3980,
      }),
      game({ date: `${y}T20:00:00Z`, myToonHandle: "1-S2-1-1", myMmr: 4014 }),
      // Today's game must NOT count toward yesterday.
      game({ date: `${DAY}T10:00:00Z`, myToonHandle: "1-S2-1-1", myMmr: 4030 }),
    ];
    const ctx = buildPulseContext(rows, DAY, TZ);
    expect(ctx.yesterday).toEqual({
      dateKey: y,
      games: 3,
      wins: 2,
      losses: 1,
      netMmr: 14,
    });
    expect(SESSION_MIN_GAMES).toBeGreaterThan(1);
  });

  test("main account picks the most-played rated ladder in the window", () => {
    const na = spread(PEAK_MIN_RATED + 2, 5, (i) => ({
      myToonHandle: "1-S2-1-100",
      myMmr: 4000 + i * 10,
    }));
    // Fewer games on EU — must not win even with higher MMR.
    const eu = spread(PEAK_MIN_RATED, 5, (i) => ({
      myToonHandle: "2-S2-1-200",
      myMmr: 5000 + i,
    }));
    const ctx = buildPulseContext([...na, ...eu], DAY, TZ);
    expect(ctx.mainAccount?.label).toBe("NA 100");
    expect(ctx.mainAccount?.currentMmr).toBe(4000 + (PEAK_MIN_RATED + 1) * 10);
    expect(ctx.mainAccount?.peakMmr).toBe(ctx.mainAccount!.currentMmr);
  });

  test("climb net is confined to the 7-day window", () => {
    // 12 rated games ending 10 days ago — outside the climb window.
    const old = spread(12, 10, (i) => ({
      myToonHandle: "1-S2-1-100",
      myMmr: 4000 + i,
    }));
    const ctx = buildPulseContext(old, DAY, TZ);
    expect(ctx.mainAccount).not.toBeNull();
    expect(ctx.mainAccount!.climbNet).toBeNull();
  });

  test("rising build compares recent form to career baseline", () => {
    // Career: 12 old decided games at 50% (6W-6L), ended 30 days ago.
    const career = spread(12, 30, (i) => ({
      myBuild: "8 Pool",
      result: i % 2 === 0 ? "Victory" : "Defeat",
    }));
    // Recent: 6 straight wins inside the 21-day window.
    const recent = spread(6, 2, () => ({ myBuild: "8 Pool" }));
    const ctx = buildPulseContext([...career, ...recent], DAY, TZ);
    expect(ctx.risingBuild?.name).toBe("8 Pool");
    expect(ctx.risingBuild!.recentWinRate).toBe(1);
    expect(ctx.risingBuild!.careerDecided).toBe(18);
    expect(RISING_BUILD_MIN_RECENT_DECIDED).toBeLessThanOrEqual(6);
    expect(RISING_BUILD_MIN_CAREER_DECIDED).toBeLessThanOrEqual(18);
  });

  test("unclassified builds can never be crowned rising or rusty", () => {
    // Same shape as the rising-build fixture above, but the "build" is a
    // detector catch-all — it must not headline "Build heating up".
    const career = spread(12, 30, (i) => ({
      myBuild: "PvP - Macro Transition (Unclassified)",
      result: i % 2 === 0 ? "Victory" : "Defeat",
    }));
    const recent = spread(6, 2, () => ({
      myBuild: "PvP - Macro Transition (Unclassified)",
    }));
    expect(
      buildPulseContext([...career, ...recent], DAY, TZ).risingBuild,
    ).toBeNull();

    // Bare sentinel + idle winning record — must not become "rusty" either.
    const sentinel = spread(RUSTY_BUILD_MIN_DECIDED + 2, 20, (i) => ({
      myBuild: "Unclassified - Protoss",
      result: i % 4 === 0 ? "Defeat" : "Victory",
    }));
    const ctx = buildPulseContext(sentinel, DAY, TZ);
    expect(ctx.risingBuild).toBeNull();
    expect(ctx.rustyBuild).toBeNull();
  });

  test("rusty build requires idle time and a winning record", () => {
    const rows = spread(RUSTY_BUILD_MIN_DECIDED + 2, 20, (i) => ({
      myBuild: "Colossus Push",
      result: i % 4 === 0 ? "Defeat" : "Victory",
    }));
    const ctx = buildPulseContext(rows, DAY, TZ);
    expect(ctx.rustyBuild?.name).toBe("Colossus Push");
    // Same build played yesterday → no longer rusty.
    const fresh = [
      ...rows,
      game({ date: `${shiftDateKey(DAY, -1)}T12:00:00Z`, myBuild: "Colossus Push" }),
    ];
    expect(buildPulseContext(fresh, DAY, TZ).rustyBuild).toBeNull();
  });

  test("nemesis needs a name, volume, a bad record, and recency", () => {
    const rows = spread(NEMESIS_MIN_DECIDED + 1, 3, (i) => ({
      oppPulseId: "opp-1",
      opponent: { displayName: "DuncanTheFat" },
      result: i === 0 ? "Victory" : "Defeat",
    }));
    const ctx = buildPulseContext(rows, DAY, TZ);
    expect(ctx.nemesis?.name).toBe("DuncanTheFat");
    expect(ctx.nemesis!.losses).toBe(NEMESIS_MIN_DECIDED);

    // Unnamed opponents can never headline a card.
    const unnamed = spread(NEMESIS_MIN_DECIDED + 1, 3, (i) => ({
      oppPulseId: "opp-2",
      result: i === 0 ? "Victory" : "Defeat",
    }));
    expect(buildPulseContext(unnamed, DAY, TZ).nemesis).toBeNull();

    // Ancient history doesn't trigger a "watch".
    const stale = spread(NEMESIS_MIN_DECIDED + 1, 120, (i) => ({
      oppPulseId: "opp-3",
      opponent: { displayName: "OldFoe" },
      result: i === 0 ? "Victory" : "Defeat",
    }));
    expect(buildPulseContext(stale, DAY, TZ).nemesis).toBeNull();
  });

  test("barcode opponents need a resolved SC2Pulse id to be tracked", () => {
    // Same losing record as the nemesis fixture, but the name is an
    // unresolved barcode → no nemesis (and no rival) card.
    const unresolved = spread(NEMESIS_MIN_DECIDED + 1, 3, (i) => ({
      oppPulseId: "1-S2-1-111",
      opponent: { displayName: "IIlIlIlIlI" },
      result: i === 0 ? "Victory" : "Defeat",
    }));
    const ctx = buildPulseContext(unresolved, DAY, TZ);
    expect(ctx.nemesis).toBeNull();
    expect(ctx.rival).toBeNull();

    // A resolved pulseCharacterId on any row confirms the identity —
    // the same barcode is then fair game.
    const resolved = spread(NEMESIS_MIN_DECIDED + 1, 3, (i) => ({
      oppPulseId: "1-S2-1-111",
      opponent: {
        displayName: "IIlIlIlIlI",
        pulseCharacterId: i === 0 ? "994428" : undefined,
      },
      result: i === 0 ? "Victory" : "Defeat",
    }));
    expect(buildPulseContext(resolved, DAY, TZ).nemesis?.name).toBe(
      "IIlIlIlIlI",
    );
  });

  test("the same player never appears as both nemesis and rival", () => {
    const rows = spread(8, 2, (i) => ({
      oppPulseId: "opp-1",
      opponent: { displayName: "Shadow" },
      result: i === 0 ? "Victory" : "Defeat",
    }));
    const ctx = buildPulseContext(rows, DAY, TZ);
    expect(ctx.nemesis?.pulseId).toBe("opp-1");
    expect(ctx.rival).toBeNull();
  });

  test("opponent cards deep-link to the player's dossier", () => {
    const rows = spread(8, 2, (i) => ({
      oppPulseId: "opp-1",
      opponent: { displayName: "Shadow" },
      result: i === 0 ? "Victory" : "Defeat",
    }));
    const ctx = buildPulseContext(rows, DAY, TZ);
    const nemesisSpec = PULSE_POOL.find((s) => s.id === "nemesis-watch")!;
    expect(nemesisSpec.eligible(ctx)).toBe(true);
    expect(nemesisSpec.build(ctx).targetOpponentId).toBe("opp-1");
  });

  test("best map prefers the live pool and honours thresholds", () => {
    const strong = spread(MAP_EDGE_MIN_DECIDED + 2, 2, () => ({
      map: "El Dorado",
    }));
    const stronger = spread(MAP_EDGE_MIN_DECIDED + 4, 2, () => ({
      map: "Retired Map",
    }));
    const ctx = buildPulseContext([...strong, ...stronger], DAY, TZ, [
      "El Dorado",
    ]);
    expect(ctx.bestMap?.name).toBe("El Dorado");
    expect(ctx.bestMap?.inPool).toBe(true);
  });

  test("matchup shift needs both career support and recent volume", () => {
    // Career vs Z: 20 decided at 50%, ended 60 days ago.
    const career = spread(20, 60, (i) => ({
      oppRace: "Zerg",
      result: i % 2 === 0 ? "Victory" : "Defeat",
    }));
    // Recent 8 straight wins vs Z inside 14 days.
    const recent = spread(8, 2, () => ({ oppRace: "Zerg" }));
    const ctx = buildPulseContext([...career, ...recent], DAY, TZ);
    expect(ctx.matchupShift?.race).toBe("Z");
    expect(ctx.matchupShift!.delta).toBeGreaterThan(0);
    expect(MATCHUP_MIN_CAREER_DECIDED).toBeLessThanOrEqual(28);
  });

  test("milestone fires only within reach of a round number", () => {
    const far = spread(60, 1, () => ({}));
    expect(buildPulseContext(far, DAY, TZ).milestone).toBeNull();
    const close = spread(90, 1, () => ({ result: "Defeat" }));
    const ctx = buildPulseContext(close, DAY, TZ);
    expect(ctx.milestone).toEqual({
      kind: "games",
      target: 100,
      current: 90,
      remaining: 10,
    });
    expect(MILESTONE_GAMES_WITHIN).toBeGreaterThanOrEqual(10);
  });

  test("throwback finds the farthest anniversary with games", () => {
    const yearAgo = shiftDateKey(DAY, -365);
    const monthAgo = shiftDateKey(DAY, -30);
    const rows = [
      game({
        date: `${yearAgo}T15:00:00Z`,
        oppMmr: 4200,
        map: "Babylon",
        opponent: { displayName: "Serral" },
      }),
      game({ date: `${yearAgo}T16:00:00Z`, result: "Defeat" }),
      game({ date: `${monthAgo}T15:00:00Z` }),
    ];
    const ctx = buildPulseContext(rows, DAY, TZ);
    expect(ctx.throwback?.lookbackDays).toBe(365);
    expect(ctx.throwback?.dateKey).toBe(yearAgo);
    expect(ctx.throwback?.wins).toBe(1);
    expect(ctx.throwback?.losses).toBe(1);
    expect(ctx.throwback?.notable).toEqual({
      opponentName: "Serral",
      oppMmr: 4200,
      map: "Babylon",
      won: true,
    });
  });

  test("bounce-back rate needs the sample floor", () => {
    // Alternating W/L: every game after a loss is a win.
    const rows = spread(BOUNCE_BACK_MIN_SAMPLES * 2 + 2, 1, (i) => ({
      result: i % 2 === 0 ? "Defeat" : "Victory",
    }));
    const ctx = buildPulseContext(rows, DAY, TZ);
    expect(ctx.bounceBackRate).toBe(1);
    const thin = spread(6, 1, (i) => ({
      result: i % 2 === 0 ? "Defeat" : "Victory",
    }));
    expect(buildPulseContext(thin, DAY, TZ).bounceBackRate).toBeNull();
  });

  test("macro trend compares the recent window to career", () => {
    const rows = spread(30, 1, (i) => ({
      macro_score: i < 15 ? 50 : 60,
    }));
    const ctx = buildPulseContext(rows, DAY, TZ);
    expect(ctx.macroDelta).not.toBeNull();
    expect(ctx.macroDelta!).toBeGreaterThan(0);
  });
});

/* ──────────────── selection ──────────────── */

describe("selectDailyPulse", () => {
  /** A rich corpus that makes many card categories eligible at once. */
  function richCorpus(): ArcadeGame[] {
    const y = shiftDateKey(DAY, -1);
    return [
      // Rated history on one account, climbing, near-100 games total.
      ...spread(40, 2, (i) => ({
        myToonHandle: "1-S2-1-100",
        myMmr: 4000 + i * 5,
        oppRace: "Zerg",
        map: i % 2 === 0 ? "El Dorado" : "Babylon",
        macro_score: 55 + (i % 10),
        result: i % 3 === 0 ? "Defeat" : "Victory",
      })),
      ...spread(45, 45, (i) => ({
        myToonHandle: "1-S2-1-100",
        myMmr: 3900 + i,
        oppRace: "Zerg",
        macro_score: 40 + (i % 10),
        result: i % 2 === 0 ? "Victory" : "Defeat",
      })),
      // Yesterday's session.
      game({ date: `${y}T18:00:00Z`, myToonHandle: "1-S2-1-100", myMmr: 4300 }),
      game({ date: `${y}T19:00:00Z`, myToonHandle: "1-S2-1-100", myMmr: 4330 }),
      game({
        date: `${y}T20:00:00Z`,
        result: "Defeat",
        myToonHandle: "1-S2-1-100",
        myMmr: 4310,
      }),
    ];
  }

  test("deterministic per (user, day) and bounded by count and TIMELY_MAX", () => {
    const games = richCorpus();
    const a = selectDailyPulse(DAY, games, { userId: "u1", tz: TZ });
    const b = selectDailyPulse(DAY, games, { userId: "u1", tz: TZ });
    expect(a.cards.map((c) => c.id)).toEqual(b.cards.map((c) => c.id));
    expect(a.cards.length).toBeLessThanOrEqual(DAILY_PULSE_COUNT);
    expect(a.cards.length).toBeGreaterThan(0);
    const timely = a.cards.filter((c) =>
      ["session", "streak", "mmr"].includes(c.category),
    );
    expect(timely.length).toBeLessThanOrEqual(TIMELY_MAX);
  });

  test("categories never repeat within a day's strip", () => {
    const sel = selectDailyPulse(DAY, richCorpus(), { userId: "u1", tz: TZ });
    const cats = sel.cards.map((c) => c.category);
    expect(new Set(cats).size).toBe(cats.length);
  });

  test("the mix rotates across days and users", () => {
    const games = richCorpus();
    const ids = (userId: string, day: string) =>
      selectDailyPulse(day, games, { userId, tz: TZ }).cards
        .map((c) => c.id)
        .join(",");
    const days = ["2026-07-18", "2026-07-19", "2026-07-20", "2026-07-21"];
    const perDay = days.map((d) => ids("u1", d));
    // At least one of four consecutive days serves a different strip
    // (contexts shift too, but even the pure shuffle must vary).
    expect(new Set(perDay).size).toBeGreaterThan(1);
  });

  test("timely session card outranks evergreen fills", () => {
    const sel = selectDailyPulse(DAY, richCorpus(), { userId: "u1", tz: TZ });
    // session-recap has the top weight and yesterday qualifies.
    expect(sel.cards[0].id).toBe("session-recap");
  });

  test("every pool spec builds a well-formed card when eligible", () => {
    // Sanity net over the whole pool: build each eligible card from the
    // rich corpus context and assert the render contract.
    const games = richCorpus();
    const { context } = selectDailyPulse(DAY, games, { userId: "u1", tz: TZ });
    for (const spec of PULSE_POOL) {
      if (!spec.eligible(context)) continue;
      const card = spec.build(context);
      expect(card.id).toBe(spec.id);
      expect(card.category).toBe(spec.category);
      expect(card.title.length).toBeGreaterThan(0);
      expect(card.body.length).toBeGreaterThan(0);
      expect(card.kicker.length).toBeGreaterThan(0);
      // No template artifacts / undefined leaks in copy.
      expect(`${card.title} ${card.body}`).not.toMatch(/undefined|NaN|null/);
    }
  });

  test("rows with junk dates or missing fields never crash selection", () => {
    const junk: ArcadeGame[] = [
      game({ date: "not-a-date" }),
      game({ date: "", result: "" }),
      { gameId: "bare", date: "2026-07-01T00:00:00Z", result: "Victory" },
      game({ myMmr: Number.NaN as unknown as number }),
      game({ myBuild: "   " }),
      game({ map: "" }),
    ];
    const sel = selectDailyPulse(DAY, junk, { userId: "u1", tz: TZ });
    expect(Array.isArray(sel.cards)).toBe(true);
  });

  test("CLIMB_MIN_DELTA gates small weekly drifts", () => {
    // 6 rated games this week drifting +5 total — under the floor.
    const rows = spread(12, 1, (i) => ({
      myToonHandle: "1-S2-1-100",
      myMmr: 4000 + (i % 2),
    }));
    const ctx = buildPulseContext(rows, DAY, TZ);
    const climb = PULSE_POOL.find((s) => s.id === "climb-recap")!;
    expect(Math.abs(ctx.mainAccount?.climbNet ?? 0)).toBeLessThan(
      CLIMB_MIN_DELTA,
    );
    expect(climb.eligible(ctx)).toBe(false);
  });
});
