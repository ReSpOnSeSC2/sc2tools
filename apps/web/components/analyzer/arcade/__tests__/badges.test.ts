import { describe, expect, test } from "vitest";
import {
  BADGE_MINERAL_REWARD,
  PLAY_BADGE_RULES,
  STOCK_MARKET_HISTORY_WEEKS,
  advanceBadgeRun,
  applyPlayBadgeProgress,
  applyStockMarketSettlement,
  greenWeekRun,
  perfectDayRun,
  previousWeekKey,
} from "../badges";
import { ARCADE_STATE_DEFAULT, type ArcadeState, type BadgeRun } from "../types";

/**
 * Five of the six Collection badges were unreachable: only Buildle Brain
 * had award code. These tests pin the rules for the other five.
 */

const NOW = new Date("2026-09-27T12:00:00Z");
const DAYS = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"];

function fresh(): ArcadeState {
  return { ...ARCADE_STATE_DEFAULT, badges: {}, records: {} };
}

function play(state: ArcadeState, modeId: string, day: string, correct: boolean) {
  return applyPlayBadgeProgress(state, { modeId, day, correct }, NOW);
}

function runOf(plays: Array<[string, boolean]>): BadgeRun | undefined {
  let run: BadgeRun | undefined;
  for (const [day, correct] of plays) run = advanceBadgeRun(run, day, correct);
  return run;
}

describe("badge rules cover every unreachable badge", () => {
  test("each Collection badge except Buildle Brain has a rule", () => {
    const badgeIds = Object.values(PLAY_BADGE_RULES).map((r) => r.badgeId).sort();
    expect(badgeIds).toEqual(["closer", "detective", "streak-hunter", "veto-sleuth"]);
  });
});

describe("perfect-day runs", () => {
  test("five consecutive perfect days reach five", () => {
    const run = runOf(DAYS.map((d) => [d, true]));
    expect(perfectDayRun(run!)).toBe(5);
  });

  test("several correct answers on one day count as one day", () => {
    const run = runOf([["2026-09-01", true], ["2026-09-01", true], ["2026-09-01", true]]);
    expect(perfectDayRun(run!)).toBe(1);
  });

  test("a wrong answer spoils the day and restarts the run", () => {
    const run = runOf([
      ["2026-09-01", true],
      ["2026-09-02", true],
      ["2026-09-02", false],
      ["2026-09-03", true],
    ]);
    expect(perfectDayRun(run!)).toBe(1);
  });

  test("a skipped day restarts the run", () => {
    const run = runOf([["2026-09-01", true], ["2026-09-02", true], ["2026-09-04", true]]);
    expect(perfectDayRun(run!)).toBe(1);
  });

  test("runs continue across a month boundary", () => {
    const run = runOf([["2026-08-31", true], ["2026-09-01", true]]);
    expect(perfectDayRun(run!)).toBe(2);
  });
});

describe("applyPlayBadgeProgress", () => {
  test.each([
    ["active-streak-hunter", "streak-hunter"],
    ["closers-eye", "closer"],
    ["loss-pattern-sleuth", "detective"],
  ])("%s awards %s on the fifth perfect day, not before", (modeId, badgeId) => {
    let state = fresh();
    for (const day of DAYS.slice(0, 4)) state = play(state, modeId, day, true);
    expect(state.badges[badgeId]).toBeUndefined();
    const before = state.minerals;
    state = play(state, modeId, DAYS[4], true);
    expect(state.badges[badgeId]).toEqual({ earnedAt: NOW.toISOString() });
    expect(state.minerals).toBe(before + BADGE_MINERAL_REWARD);
  });

  test("Veto Sleuth needs three correct Streak Veto answers in a row", () => {
    let state = fresh();
    state = play(state, "streak-veto", "2026-09-01", true);
    state = play(state, "streak-veto", "2026-09-01", true);
    state = play(state, "streak-veto", "2026-09-01", false);
    state = play(state, "streak-veto", "2026-09-01", true);
    state = play(state, "streak-veto", "2026-09-03", true);
    expect(state.badges["veto-sleuth"]).toBeUndefined();
    state = play(state, "streak-veto", "2026-09-09", true);
    expect(state.badges["veto-sleuth"]).toBeDefined();
  });

  test("a badge is granted once and its reward is not paid twice", () => {
    let state = fresh();
    for (const day of DAYS) state = play(state, "closers-eye", day, true);
    const earned = state.badges.closer;
    const minerals = state.minerals;
    state = play(state, "closers-eye", "2026-09-06", true);
    expect(state.badges.closer).toBe(earned);
    expect(state.minerals).toBe(minerals);
  });

  test("modes without a badge rule pass through untouched", () => {
    const state = fresh();
    expect(play(state, "buildle", "2026-09-01", true)).toBe(state);
  });

  test("progress survives state blobs saved before badgeRuns existed", () => {
    const legacy = fresh();
    delete legacy.badgeRuns;
    const next = play(legacy, "closers-eye", "2026-09-01", true);
    expect(next.badgeRuns?.["closers-eye"]?.day).toBe("2026-09-01");
  });
});

describe("ISO week helpers", () => {
  test.each([
    ["2026-W40", "2026-W39"],
    ["2026-W01", "2025-W52"],
    ["2021-W01", "2020-W53"],
  ])("previous week of %s is %s", (week, previous) => {
    expect(previousWeekKey(week)).toBe(previous);
  });

  test("rejects malformed keys", () => {
    expect(previousWeekKey("2026-40")).toBeNull();
  });

  test("greenWeekRun stops at a red, flat or missing week", () => {
    const history = {
      "2026-W36": { pnlPct: 3, settledAt: "" },
      "2026-W37": { pnlPct: 0, settledAt: "" },
      "2026-W38": { pnlPct: 1.5, settledAt: "" },
      "2026-W39": { pnlPct: 2, settledAt: "" },
    };
    expect(greenWeekRun(history, "2026-W39")).toBe(2);
    expect(greenWeekRun(history, "2026-W40")).toBe(0);
  });
});

describe("applyStockMarketSettlement", () => {
  const settle = (state: ArcadeState, weekKey: string, pnlPct: number) =>
    applyStockMarketSettlement(state, { weekKey, pnlPct }, NOW);

  test("five consecutive green weeks earn Tycoon", () => {
    let state = fresh();
    for (const wk of ["2026-W35", "2026-W36", "2026-W37", "2026-W38"]) {
      state = settle(state, wk, 2);
    }
    expect(state.badges.tycoon).toBeUndefined();
    state = settle(state, "2026-W39", 0.4);
    expect(state.badges.tycoon).toBeDefined();
  });

  test("a gap week or a red week breaks the streak", () => {
    let state = fresh();
    for (const wk of ["2026-W30", "2026-W31", "2026-W33", "2026-W34", "2026-W35"]) {
      state = settle(state, wk, 2);
    }
    state = settle(state, "2026-W36", -1);
    state = settle(state, "2026-W37", 5);
    expect(state.badges.tycoon).toBeUndefined();
  });

  test("a settled week is never rewritten", () => {
    let state = settle(fresh(), "2026-W39", -3);
    state = settle(state, "2026-W39", 50);
    expect(state.stockMarketHistory?.["2026-W39"].pnlPct).toBe(-3);
  });

  test("history keeps only the most recent weeks", () => {
    let state = fresh();
    for (let w = 1; w <= STOCK_MARKET_HISTORY_WEEKS + 3; w += 1) {
      state = settle(state, `2026-W${String(w).padStart(2, "0")}`, 1);
    }
    const weeks = Object.keys(state.stockMarketHistory ?? {}).sort();
    expect(weeks).toHaveLength(STOCK_MARKET_HISTORY_WEEKS);
    expect(weeks[0]).toBe("2026-W04");
  });

  test("ignores malformed input", () => {
    const state = fresh();
    expect(settle(state, "W39", 3)).toBe(state);
    expect(settle(state, "2026-W39", Number.NaN)).toBe(state);
  });
});
