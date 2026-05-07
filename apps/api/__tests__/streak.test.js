// @ts-nocheck
"use strict";

const {
  StreakService,
  walkStreak,
  STREAK_SCAN_LIMIT,
} = require("../src/services/streak");

function buildGames(handler) {
  return {
    aggregate(pipeline) {
      return {
        toArray: () => Promise.resolve(handler(pipeline)),
      };
    },
  };
}

describe("services/streak", () => {
  describe("walkStreak (pure, server-side reducer)", () => {
    test("empty input returns zero-streak placeholder", () => {
      expect(walkStreak([])).toEqual({
        kind: null,
        count: 0,
        lastGameAt: null,
      });
    });

    test("non-array input returns the same placeholder", () => {
      // @ts-ignore — exercising the defensive branch
      expect(walkStreak(null)).toEqual({
        kind: null,
        count: 0,
        lastGameAt: null,
      });
    });

    test("counts a pure win streak across all games", () => {
      const out = walkStreak([
        { result: "Victory", date: new Date("2026-05-07T18:00:00Z") },
        { result: "win", date: new Date("2026-05-07T17:00:00Z") },
        { result: "Victory", date: new Date("2026-05-07T16:00:00Z") },
      ]);
      expect(out.kind).toBe("win");
      expect(out.count).toBe(3);
      expect(out.lastGameAt).toBe("2026-05-07T18:00:00.000Z");
    });

    test("breaks at the first opposite outcome", () => {
      const out = walkStreak([
        { result: "Victory", date: new Date("2026-05-07T20:00:00Z") },
        { result: "Victory", date: new Date("2026-05-07T19:00:00Z") },
        { result: "Defeat", date: new Date("2026-05-07T18:00:00Z") },
        { result: "Victory", date: new Date("2026-05-07T17:00:00Z") },
      ]);
      expect(out).toEqual({
        kind: "win",
        count: 2,
        lastGameAt: "2026-05-07T20:00:00.000Z",
      });
    });

    test("counts a loss streak when the trail is losses", () => {
      const out = walkStreak([
        { result: "Defeat", date: new Date("2026-05-07T20:00:00Z") },
        { result: "loss", date: new Date("2026-05-07T19:00:00Z") },
        { result: "Victory", date: new Date("2026-05-07T18:00:00Z") },
      ]);
      expect(out.kind).toBe("loss");
      expect(out.count).toBe(2);
    });

    test("ties at the head are skipped, not break the streak", () => {
      // A tie is not a "decided" outcome — it shouldn't reset a
      // streak the user is genuinely on. This is the legacy SPA's
      // behaviour and what the session widget already does.
      const out = walkStreak([
        { result: "Tie", date: new Date("2026-05-07T20:00:00Z") },
        { result: "Victory", date: new Date("2026-05-07T19:00:00Z") },
        { result: "Victory", date: new Date("2026-05-07T18:00:00Z") },
      ]);
      expect(out).toEqual({
        kind: "win",
        count: 2,
        lastGameAt: "2026-05-07T19:00:00.000Z",
      });
    });

    test("mixed-day games no longer collapse the streak to 0", () => {
      // Regression: the old client-side reducer aggregated by day and
      // treated any day with both wins and losses as a hard break,
      // dropping the streak to 0 even when the user was mid-streak.
      // Walking individual games keeps the streak intact.
      const out = walkStreak([
        // Today, newest first: W W W L W W W
        { result: "Victory", date: new Date("2026-05-07T22:00:00Z") },
        { result: "Victory", date: new Date("2026-05-07T21:00:00Z") },
        { result: "Victory", date: new Date("2026-05-07T20:00:00Z") },
        { result: "Defeat", date: new Date("2026-05-07T19:00:00Z") },
        { result: "Victory", date: new Date("2026-05-07T18:00:00Z") },
        { result: "Victory", date: new Date("2026-05-07T17:00:00Z") },
        { result: "Victory", date: new Date("2026-05-07T16:00:00Z") },
      ]);
      expect(out.kind).toBe("win");
      expect(out.count).toBe(3);
    });

    test("non-string results are ignored as ties", () => {
      const out = walkStreak([
        { result: undefined },
        { result: 42 },
        { result: "Victory", date: new Date("2026-05-07T16:00:00Z") },
      ]);
      expect(out.kind).toBe("win");
      expect(out.count).toBe(1);
    });

    test("invalid date in the streak head row drops lastGameAt to null", () => {
      const out = walkStreak([
        { result: "Victory", date: "not-a-date" },
      ]);
      expect(out.kind).toBe("win");
      expect(out.count).toBe(1);
      expect(out.lastGameAt).toBeNull();
    });
  });

  describe("StreakService.current", () => {
    test("walks the aggregation output and returns the trail", async () => {
      const games = buildGames(() => [
        { result: "Victory", date: new Date("2026-05-07T18:00:00Z") },
        { result: "Victory", date: new Date("2026-05-07T17:00:00Z") },
        { result: "Defeat", date: new Date("2026-05-07T16:00:00Z") },
      ]);
      const svc = new StreakService({ games });
      const out = await svc.current("u1", {});
      expect(out).toEqual({
        kind: "win",
        count: 2,
        lastGameAt: "2026-05-07T18:00:00.000Z",
      });
    });

    test("pipeline scopes by user, sorts newest-first, and caps the scan", async () => {
      let captured;
      const games = buildGames((pipeline) => {
        captured = pipeline;
        return [];
      });
      const svc = new StreakService({ games });
      await svc.current("u1", {});
      expect(captured[0]).toEqual({ $match: { userId: "u1" } });
      expect(captured[1]).toEqual({ $sort: { date: -1 } });
      expect(captured[2]).toEqual({ $limit: STREAK_SCAN_LIMIT });
    });

    test("filter window narrows the match", async () => {
      let captured;
      const games = buildGames((pipeline) => {
        captured = pipeline;
        return [];
      });
      const svc = new StreakService({ games });
      const since = new Date("2026-04-01T00:00:00Z");
      await svc.current("u1", { since });
      expect(captured[0].$match.userId).toBe("u1");
      expect(captured[0].$match.date.$gte).toEqual(since);
    });

    test("returns the empty-state object for users with no games", async () => {
      const games = buildGames(() => []);
      const svc = new StreakService({ games });
      const out = await svc.current("u1", {});
      expect(out).toEqual({ kind: null, count: 0, lastGameAt: null });
    });

    test("filters with no recognisable result fall back to no streak", async () => {
      const games = buildGames(() => [
        { result: "Tie" },
        { result: null },
        { result: "" },
      ]);
      const svc = new StreakService({ games });
      const out = await svc.current("u1", {});
      expect(out).toEqual({ kind: null, count: 0, lastGameAt: null });
    });
  });
});
