import { describe, expect, test } from "vitest";
import {
  activeLossStreak,
  activeWinStreak,
  dailySeed,
  longestBrokenLossStreak,
  longestBrokenWinStreak,
  longestLossStreak,
  longestWinStreak,
  fnv1a,
  isCannonRush,
  levelForXp,
  mulberry32,
  pickN,
  sessionize,
  shuffle,
  streakVetoRuns,
  todayKey,
  weekKey,
  xpForNextLevel,
} from "../ArcadeEngine";
import type { ArcadeGame } from "../types";

const g = (over: Partial<ArcadeGame> = {}): ArcadeGame => ({
  gameId: over.gameId ?? "x",
  date: over.date ?? "2026-05-01T12:00:00Z",
  result: over.result ?? "Win",
  ...over,
});

describe("mulberry32 seeded RNG", () => {
  test("same seed produces the same sequence", () => {
    const a = mulberry32(0xdeadbeef);
    const b = mulberry32(0xdeadbeef);
    for (let i = 0; i < 8; i++) {
      expect(a()).toBe(b());
    }
  });
  test("different seeds diverge", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });
});

describe("dailySeed + fnv1a", () => {
  test("dailySeed is stable across runs for the same (user, day)", () => {
    expect(dailySeed("user-1", "2026-05-10")).toBe(
      dailySeed("user-1", "2026-05-10"),
    );
  });
  test("changing either input changes the seed", () => {
    expect(dailySeed("user-1", "2026-05-10")).not.toBe(
      dailySeed("user-2", "2026-05-10"),
    );
    expect(dailySeed("user-1", "2026-05-10")).not.toBe(
      dailySeed("user-1", "2026-05-11"),
    );
  });
  test("fnv1a is non-zero for non-empty input", () => {
    expect(fnv1a("hello")).toBeGreaterThan(0);
  });
});

describe("todayKey / weekKey", () => {
  test("UTC todayKey is YYYY-MM-DD", () => {
    expect(todayKey(new Date("2026-05-10T03:00:00Z"), "UTC")).toBe("2026-05-10");
  });
  test("weekKey is ISO YYYY-Www", () => {
    expect(weekKey(new Date("2026-05-10T12:00:00Z"), "UTC")).toMatch(/^\d{4}-W\d{2}$/);
  });
});

describe("activeWinStreak", () => {
  test("returns 0 on empty list", () => {
    expect(activeWinStreak([])).toBe(0);
  });
  test("counts trailing wins", () => {
    expect(
      activeWinStreak([{ result: "Loss" }, { result: "Win" }, { result: "Win" }]),
    ).toBe(2);
  });
  test("returns 0 when most recent is a loss", () => {
    expect(
      activeWinStreak([{ result: "Win" }, { result: "Win" }, { result: "Loss" }]),
    ).toBe(0);
  });
  test("undecided games are skipped without breaking the streak", () => {
    expect(
      activeWinStreak([
        { result: "Win" },
        { result: "Tie" },
        { result: "Win" },
      ]),
    ).toBe(2);
  });
});

describe("activeLossStreak", () => {
  test("returns 0 on empty list", () => {
    expect(activeLossStreak([])).toBe(0);
  });
  test("counts trailing losses (= opponent's active wins)", () => {
    expect(
      activeLossStreak([{ result: "Win" }, { result: "Loss" }, { result: "Loss" }]),
    ).toBe(2);
  });
  test("returns 0 when most recent decided game is a win", () => {
    expect(
      activeLossStreak([{ result: "Loss" }, { result: "Loss" }, { result: "Win" }]),
    ).toBe(0);
  });
  test("is the mirror of activeWinStreak", () => {
    // Same chronological game list — exactly one of the two helpers
    // should ever return >0, never both.
    const seq = [{ result: "Win" }, { result: "Win" }, { result: "Loss" }];
    expect(activeWinStreak(seq) > 0 && activeLossStreak(seq) > 0).toBe(false);
    expect(activeLossStreak(seq)).toBe(1);
  });
});

describe("longestWinStreak / longestLossStreak", () => {
  test("longestWinStreak returns 0 on empty list", () => {
    expect(longestWinStreak([])).toBe(0);
  });
  test("longestWinStreak walks the whole history, not just the trailing run", () => {
    // 4-W run early, then losses, then 2-W run at the end. The
    // *active* trailing W-streak is 2 but historical longest is 4.
    expect(
      longestWinStreak([
        { result: "Win" },
        { result: "Win" },
        { result: "Win" },
        { result: "Win" },
        { result: "Loss" },
        { result: "Loss" },
        { result: "Win" },
        { result: "Win" },
      ]),
    ).toBe(4);
  });
  test("longestLossStreak mirrors longestWinStreak for the opposite outcome", () => {
    expect(
      longestLossStreak([
        { result: "Loss" },
        { result: "Loss" },
        { result: "Loss" },
        { result: "Win" },
        { result: "Loss" },
      ]),
    ).toBe(3);
  });
  test("undecided games reset neither streak (they're skipped)", () => {
    expect(
      longestWinStreak([
        { result: "Win" },
        { result: "Tie" },
        { result: "Win" },
        { result: "Loss" },
      ]),
    ).toBe(2);
  });
});

describe("longestBrokenLossStreak / longestBrokenWinStreak", () => {
  test("counts the run only when a terminator follows it", () => {
    // 3-L run terminated by a W → broken length 3. Trailing 2-L run
    // never gets terminated in the sample → excluded.
    expect(
      longestBrokenLossStreak([
        { result: "Loss" },
        { result: "Loss" },
        { result: "Loss" },
        { result: "Win" },
        { result: "Loss" },
        { result: "Loss" },
      ]),
    ).toBe(3);
  });
  test("longestBrokenWinStreak captures the largest W-run snapped by an L", () => {
    expect(
      longestBrokenWinStreak([
        { result: "Win" },
        { result: "Win" },
        { result: "Loss" },
        { result: "Win" },
        { result: "Win" },
        { result: "Win" },
        { result: "Win" },
        { result: "Loss" },
        { result: "Win" },
      ]),
    ).toBe(4);
  });
  test("returns 0 when no run is ever broken", () => {
    // 3 W's, never terminated.
    expect(
      longestBrokenWinStreak([{ result: "Win" }, { result: "Win" }, { result: "Win" }]),
    ).toBe(0);
  });
});

describe("streakVetoRuns", () => {
  test("captures runs ended by a loss with the right length", () => {
    const games = [
      g({ gameId: "1", result: "Win" }),
      g({ gameId: "2", result: "Win" }),
      g({ gameId: "3", result: "Win" }),
      g({ gameId: "4", result: "Loss" }),
      g({ gameId: "5", result: "Win" }),
      g({ gameId: "6", result: "Loss" }),
    ];
    const runs = streakVetoRuns(games);
    expect(runs.length).toBe(2);
    expect(runs[0]).toMatchObject({ length: 3, endedById: "4" });
    expect(runs[1]).toMatchObject({ length: 1, endedById: "6" });
  });
  test("excludes the trailing active run (no terminating loss)", () => {
    const games = [
      g({ gameId: "1", result: "Loss" }),
      g({ gameId: "2", result: "Win" }),
      g({ gameId: "3", result: "Win" }),
    ];
    const runs = streakVetoRuns(games);
    expect(runs.length).toBe(0);
  });
});

describe("sessionize (4h gap)", () => {
  test("splits across a >4h gap", () => {
    const games = [
      g({ gameId: "1", date: "2026-05-10T01:00:00Z" }),
      g({ gameId: "2", date: "2026-05-10T02:00:00Z" }),
      g({ gameId: "3", date: "2026-05-10T08:00:00Z" }),
    ];
    const sessions = sessionize(games);
    expect(sessions.length).toBe(2);
    expect(sessions[0].games.length).toBe(2);
    expect(sessions[1].games[0].gameId).toBe("3");
  });
  test("empty array returns empty session list", () => {
    expect(sessionize([])).toEqual([]);
  });
});

describe("isCannonRush", () => {
  test("matches the substring case-insensitively", () => {
    expect(isCannonRush("Cannon Rush")).toBe(true);
    expect(isCannonRush("cannon rush")).toBe(true);
    expect(isCannonRush("PvT — cannon rush variant")).toBe(true);
  });
  test("ignores other build names", () => {
    expect(isCannonRush("Reaper FE")).toBe(false);
    expect(isCannonRush("1/1/1")).toBe(false);
    expect(isCannonRush(undefined)).toBe(false);
    expect(isCannonRush(null)).toBe(false);
  });
});

describe("shuffle / pickN with seeded RNG", () => {
  test("shuffle is deterministic for a fixed seed", () => {
    const arr = ["a", "b", "c", "d", "e"];
    const s1 = shuffle(arr, mulberry32(42));
    const s2 = shuffle(arr, mulberry32(42));
    expect(s1).toEqual(s2);
  });
  test("pickN returns at most n items", () => {
    const out = pickN([1, 2, 3], 5, mulberry32(1));
    expect(out.length).toBe(3);
  });
});

describe("XP curve", () => {
  test("level 1 at 0 XP, level 2 at 100 XP", () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(100)).toBe(2);
    expect(levelForXp(99)).toBe(1);
  });
  test("xpForNextLevel reports current/needed correctly", () => {
    const v = xpForNextLevel(100); // exactly level 2
    expect(v).toEqual({ current: 0, needed: 150 });
  });
});
