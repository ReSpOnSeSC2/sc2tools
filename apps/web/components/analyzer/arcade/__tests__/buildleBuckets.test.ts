import { describe, expect, test } from "vitest";
import {
  ageBucket,
  buildleShareText,
  dayOfYear,
  durationBucket,
  opponentOpenerBucket,
  openersForRace,
  questionTypeForDay,
  resultBucket,
  ROTATION,
  streakBucket,
  streakGoingIntoGame,
  timeOfDayBucket,
  timesPlayedBucket,
  wrBucket,
  QUESTION_LABEL,
} from "../modes/games/buildle";
import type { ArcadeGame, BuildleProgress } from "../types";

describe("Buildle — duration buckets", () => {
  test("seconds → bucket boundaries are exclusive on the top edge", () => {
    expect(durationBucket(0)).toBe("Under 5 min");
    expect(durationBucket(60 * 4 + 59)).toBe("Under 5 min");
    expect(durationBucket(60 * 5)).toBe("5–10 min");
    expect(durationBucket(60 * 9 + 59)).toBe("5–10 min");
    expect(durationBucket(60 * 10)).toBe("10–15 min");
    expect(durationBucket(60 * 14 + 59)).toBe("10–15 min");
    expect(durationBucket(60 * 15)).toBe("15+ min");
    expect(durationBucket(60 * 90)).toBe("15+ min");
  });
});

describe("Buildle — result buckets", () => {
  test("Win/Loss casings normalise; undecided returns null", () => {
    expect(resultBucket("Win")).toBe("Win");
    expect(resultBucket("victory")).toBe("Win");
    expect(resultBucket("Loss")).toBe("Loss");
    expect(resultBucket("defeat")).toBe("Loss");
    expect(resultBucket("")).toBeNull();
    expect(resultBucket("tie")).toBeNull();
  });
});

describe("Buildle — age buckets (last 365 days only)", () => {
  const now = new Date("2026-05-11T12:00:00Z");
  const daysAgo = (n: number) =>
    new Date(now.getTime() - n * 86_400_000).toISOString();
  test("each bucket maps to the right window; out-of-range → null", () => {
    expect(ageBucket(daysAgo(0), now)).toBe("Last 30 days");
    expect(ageBucket(daysAgo(30), now)).toBe("Last 30 days");
    expect(ageBucket(daysAgo(31), now)).toBe("1–3 months ago");
    expect(ageBucket(daysAgo(90), now)).toBe("1–3 months ago");
    expect(ageBucket(daysAgo(91), now)).toBe("3–6 months ago");
    expect(ageBucket(daysAgo(180), now)).toBe("3–6 months ago");
    expect(ageBucket(daysAgo(181), now)).toBe("6–12 months ago");
    expect(ageBucket(daysAgo(365), now)).toBe("6–12 months ago");
    expect(ageBucket(daysAgo(366), now)).toBeNull();
  });
});

describe("Buildle — time-of-day buckets", () => {
  test("buckets segment 24h into four equal 6h windows", () => {
    const at = (h: number) => {
      const d = new Date(2026, 4, 11);
      d.setHours(h, 0, 0, 0);
      return d.toISOString();
    };
    expect(timeOfDayBucket(at(6))).toBe("Morning");
    expect(timeOfDayBucket(at(11))).toBe("Morning");
    expect(timeOfDayBucket(at(12))).toBe("Afternoon");
    expect(timeOfDayBucket(at(17))).toBe("Afternoon");
    expect(timeOfDayBucket(at(18))).toBe("Evening");
    expect(timeOfDayBucket(at(23))).toBe("Evening");
    expect(timeOfDayBucket(at(0))).toBe("Night");
    expect(timeOfDayBucket(at(5))).toBe("Night");
  });
});

describe("Buildle — times-played buckets", () => {
  test("first-time vs depth tiers", () => {
    expect(timesPlayedBucket(1)).toBe("1st time");
    expect(timesPlayedBucket(2)).toBe("2–5");
    expect(timesPlayedBucket(5)).toBe("2–5");
    expect(timesPlayedBucket(6)).toBe("6–15");
    expect(timesPlayedBucket(15)).toBe("6–15");
    expect(timesPlayedBucket(16)).toBe("16+");
    expect(timesPlayedBucket(99)).toBe("16+");
  });
});

describe("Buildle — career WR buckets", () => {
  test("quarter-bands; 1.0 lands in the top bucket", () => {
    expect(wrBucket(0)).toBe("0–25%");
    expect(wrBucket(0.24)).toBe("0–25%");
    expect(wrBucket(0.25)).toBe("25–50%");
    expect(wrBucket(0.49)).toBe("25–50%");
    expect(wrBucket(0.5)).toBe("50–75%");
    expect(wrBucket(0.74)).toBe("50–75%");
    expect(wrBucket(0.75)).toBe("75–100%");
    expect(wrBucket(1)).toBe("75–100%");
  });
});

describe("Buildle — streak buckets (signed)", () => {
  test("positive → wins, negative → losses; thresholds at ±3", () => {
    expect(streakBucket(5)).toBe("3+ win streak");
    expect(streakBucket(3)).toBe("3+ win streak");
    expect(streakBucket(2)).toBe("1–2 wins");
    expect(streakBucket(1)).toBe("1–2 wins");
    expect(streakBucket(-1)).toBe("1–2 losses");
    expect(streakBucket(-2)).toBe("1–2 losses");
    expect(streakBucket(-3)).toBe("3+ loss streak");
    expect(streakBucket(-10)).toBe("3+ loss streak");
  });
});

describe("Buildle — streakGoingIntoGame walks backwards from the game's index", () => {
  const mk = (id: string, result: "Win" | "Loss" | "Tie"): ArcadeGame => ({
    gameId: id,
    date: `2026-01-${id.padStart(2, "0")}T00:00:00Z`,
    result,
  });
  test("returns 0 when the target is the first game", () => {
    const games: ArcadeGame[] = [mk("1", "Win"), mk("2", "Loss")];
    expect(streakGoingIntoGame(games, 0)).toBe(0);
  });
  test("counts contiguous wins backwards", () => {
    const games: ArcadeGame[] = [
      mk("1", "Win"),
      mk("2", "Win"),
      mk("3", "Win"),
      mk("4", "Loss"),
    ];
    expect(streakGoingIntoGame(games, 3)).toBe(3);
  });
  test("counts contiguous losses backwards (negative)", () => {
    const games: ArcadeGame[] = [
      mk("1", "Loss"),
      mk("2", "Loss"),
      mk("3", "Win"),
    ];
    expect(streakGoingIntoGame(games, 2)).toBe(-2);
  });
  test("undecided games are skipped, not break runs", () => {
    const games: ArcadeGame[] = [
      mk("1", "Win"),
      mk("2", "Tie"),
      mk("3", "Win"),
      mk("4", "Loss"),
    ];
    expect(streakGoingIntoGame(games, 3)).toBe(2);
  });
  test("changes in direction terminate the streak count", () => {
    const games: ArcadeGame[] = [
      mk("1", "Loss"),
      mk("2", "Win"),
      mk("3", "Win"),
      mk("4", "Loss"),
    ];
    expect(streakGoingIntoGame(games, 3)).toBe(2);
  });
});

describe("Buildle — opponent opener bucketing", () => {
  test("known phrases collapse to canonical labels (race-tagged)", () => {
    expect(opponentOpenerBucket("ling-bane all-in")).toBe("Ling-Bane all-in");
    expect(opponentOpenerBucket("zergling baneling rush")).toBe("Ling-Bane all-in");
    expect(opponentOpenerBucket("Reaper FE")).toBe("Reaper expand");
    expect(opponentOpenerBucket("oracle harass")).toBe("Oracle harass");
    expect(opponentOpenerBucket("cannon rush")).toBe("Cannon rush");
  });
  test("unknown strings return null", () => {
    expect(opponentOpenerBucket(null)).toBeNull();
    expect(opponentOpenerBucket("")).toBeNull();
    expect(opponentOpenerBucket("something nobody has ever played")).toBeNull();
  });
  test("openersForRace returns only race-appropriate + cross-race openers", () => {
    const z = openersForRace("Z");
    expect(z).toContain("Ling-Bane all-in");
    expect(z).toContain("Macro game"); // cross-race shared
    expect(z).not.toContain("Reaper expand"); // Terran-only
    expect(z).not.toContain("Oracle harass"); // Protoss-only
  });
});

describe("Buildle — rotation + day-of-year mapping", () => {
  test("ROTATION has 9 unique question types", () => {
    expect(ROTATION).toHaveLength(9);
    expect(new Set(ROTATION).size).toBe(9);
  });
  test("dayOfYear is 0 for Jan 1 and 31 for Feb 1", () => {
    expect(dayOfYear("2026-01-01")).toBe(0);
    expect(dayOfYear("2026-02-01")).toBe(31);
  });
  test("questionTypeForDay is deterministic and cycles every 9 days", () => {
    const a = questionTypeForDay("2026-05-11");
    const b = questionTypeForDay("2026-05-20"); // 9 days later
    expect(a).toBe(b);
  });
  test("each rotation slot is reachable across 9 consecutive days", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 9; i++) {
      const d = new Date("2026-01-01T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + i);
      seen.add(questionTypeForDay(d.toISOString().slice(0, 10)));
    }
    expect(seen.size).toBe(9);
  });
  test("every rotation entry has a display label", () => {
    for (const t of ROTATION) {
      expect(QUESTION_LABEL[t]).toBeTruthy();
    }
  });
});

describe("Buildle — share text", () => {
  test("unplayed renders an unmarked one-liner", () => {
    expect(buildleShareText(undefined, "2026-05-11")).toContain("not played yet");
  });
  test("correct pick → green check; wrong pick → red x", () => {
    const correct: BuildleProgress = {
      gameId: "g1",
      questionType: "duration",
      options: ["Under 5 min", "5–10 min", "10–15 min", "15+ min"],
      correctIndex: 2,
      pickedIndex: 2,
      correct: true,
    };
    const wrong: BuildleProgress = { ...correct, pickedIndex: 0, correct: false };
    expect(buildleShareText(correct, "2026-05-11")).toMatch(/✅/);
    expect(buildleShareText(correct, "2026-05-11")).toContain("Game duration");
    expect(buildleShareText(wrong, "2026-05-11")).toMatch(/❌/);
  });
});
