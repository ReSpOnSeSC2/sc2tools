import { describe, expect, it } from "vitest";
import {
  addDays,
  defaultWindow,
  goalDeepLink,
  mondayOf,
  periodLabel,
  previewLabel,
  progressText,
  sampleGuard,
  streakText,
  todayGoals,
  type Goal,
  type GoalProgress,
} from "../goals";

function progress(overrides: Partial<GoalProgress> = {}): GoalProgress {
  return {
    state: "active", target: 5, value: 2, fraction: 0.4, games: 2, phase: "progress", met: false,
    needed: null, minGames: null, current: { key: "2026-11-09", startsAt: "2026-11-09T05:00:00.000Z", endsAt: "2026-11-16T05:00:00.000Z" },
    buckets: { total: 4, elapsed: 2, met: 1 }, ...overrides,
  };
}

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "g_1", type: "games_played", params: { target: 5 }, filters: { matchup: "PvZ", map: null, ranked: true },
    window: { recurrence: "weekly", startsOn: "2026-11-02", endsOn: "2026-11-29", tz: "America/New_York", season: null },
    title: null, label: "Play 5 ranked PvZ games each week", pinned: true, status: "active", outcome: null,
    completedAt: null, createdAt: null, progress: progress(), ...overrides,
  };
}

describe("goal windows", () => {
  it("starts weekly goals on this week's Monday and monthly ones on the 1st", () => {
    expect(mondayOf("2026-11-11")).toBe("2026-11-09");
    expect(mondayOf("2026-11-09")).toBe("2026-11-09");
    expect(defaultWindow("weekly", "2026-11-11")).toEqual({ startsOn: "2026-11-09", endsOn: "2027-01-03" });
    expect(defaultWindow("monthly", "2026-11-11")).toEqual({ startsOn: "2026-11-01", endsOn: "2027-01-31" });
    expect(defaultWindow("daily", "2026-12-25")).toEqual({ startsOn: "2026-12-25", endsOn: "2027-01-07" });
    expect(defaultWindow("once", "2026-11-11")).toEqual({ startsOn: "2026-11-11", endsOn: "2026-12-10" });
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("goal copy", () => {
  it("guards a rate or average until its minimum sample", () => {
    const rate = goal({ type: "win_rate", params: { target: 55, minGames: 20 }, progress: progress({ phase: "sample", needed: 9, games: 11, value: null, minGames: 20 }) });
    expect(sampleGuard(rate)).toBe("9 more games before this rate counts");
    expect(progressText(rate)).toBe("11 of 20 decided games");
    const one = goal({ type: "sq_avg", progress: progress({ phase: "sample", needed: 1, games: 4, value: null, minGames: 5 }) });
    expect(sampleGuard(one)).toBe("1 more game before this average counts");
    const mmr = goal({ type: "mmr_reach", params: { target: 4000 }, progress: progress({ phase: "sample", noRatedGames: true, value: null }) });
    expect(sampleGuard(mmr)).toBe("No rated games yet");
    expect(sampleGuard(goal())).toBeNull();
  });

  it("describes progress, period and met periods", () => {
    expect(progressText(goal())).toBe("2 of 5 games");
    expect(progressText(goal({ type: "build_reps", progress: progress({ checkins: 1 }) }))).toBe("2 of 5 games · 1 by check-in");
    expect(progressText(goal({ type: "win_rate", params: { target: 55 }, progress: progress({ value: 57.5 }) }))).toMatch(/57\.5% won · target 55%/);
    expect(periodLabel(goal())).toBe("This week");
    expect(periodLabel(goal({ window: { ...goal().window, recurrence: "season", season: 68 } }))).toBe("Season 68");
    expect(streakText(goal())).toBe("Met 1 of 2 weeks");
  });

  it("previews the same sentence the API labels saved goals with", () => {
    expect(previewLabel({ type: "games_played", params: { target: 5 }, filters: { matchup: "PvZ", map: null, ranked: true },
      window: { recurrence: "weekly", startsOn: "", endsOn: "", tz: "UTC", season: null } })).toBe("Play 5 ranked PvZ games each week");
    expect(previewLabel({ type: "mmr_reach", params: { target: 4500 }, filters: { matchup: null, map: null, ranked: true },
      window: { recurrence: "season", startsOn: "", endsOn: "", tz: "UTC", season: 68 } })).toBe("Reach 4,500 MMR in Season 68");
  });
});

describe("goal deep links and Today", () => {
  it("links to the section that lists the current period's counted games", () => {
    const href = new URL(goalDeepLink(goal()), "https://example.test");
    expect(href.pathname).toBe("/app/replays");
    expect(Object.fromEntries(href.searchParams)).toMatchObject({
      preset: "custom", since: "2026-11-09T05:00:00.000Z", until: "2026-11-16T04:59:59.999Z",
      map_pool: "ladder", game_size: "1v1", race: "P", opp_race: "Z",
    });
    const build = new URL(goalDeepLink(goal({ type: "build_reps", params: { target: 5, build: { key: "pvz-x", name: "PvZ - X", slug: null, source: "catalog" } } })), "https://example.test");
    expect(build.pathname).toBe("/app/builds");
    expect(build.searchParams.get("build")).toBe("PvZ - X");
  });

  it("shows only pinned goals on Today, at most three", () => {
    const goals = [goal({ id: "a" }), goal({ id: "b", pinned: false }), goal({ id: "c" }), goal({ id: "d" }), goal({ id: "e" })];
    expect(todayGoals(goals).map((g) => g.id)).toEqual(["a", "c", "d"]);
  });
});
