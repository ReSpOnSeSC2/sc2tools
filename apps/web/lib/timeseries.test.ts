import { describe, expect, test } from "vitest";
import {
  apiToPeriods,
  localDateKey,
  startOfTodayInTz,
  todayKeyIn,
} from "./timeseries";

describe("startOfTodayInTz", () => {
  test("returns the user's local midnight even when UTC has rolled over", () => {
    // 2026-05-10T02:43:00Z is 2026-05-09 21:43 in America/Chicago
    // (CDT, UTC-5). The user is still on May 9 locally.
    const now = new Date("2026-05-10T02:43:00Z");
    const start = startOfTodayInTz("America/Chicago", now);

    // Start of May 9 in Chicago = 2026-05-09T05:00:00Z
    expect(start.toISOString()).toBe("2026-05-09T05:00:00.000Z");
    expect(localDateKey(start, "America/Chicago")).toBe("2026-05-09");
  });

  test("matches the same date as todayKeyIn", () => {
    const tzs = ["America/Los_Angeles", "Europe/London", "Pacific/Auckland", "UTC"];
    const now = new Date("2026-05-10T02:43:00Z");
    for (const tz of tzs) {
      const start = startOfTodayInTz(tz, now);
      expect(localDateKey(start, tz)).toBe(todayKeyIn(tz, now));
    }
  });

  test("startOfTodayInTz and todayKeyIn agree for arbitrary instants across UTC offsets", () => {
    // Regression: previously `todayKeyIn` ignored the injected clock,
    // so callers that needed the two helpers to align (e.g. building a
    // `since=startOfTodayInTz` filter that the consumer then keyed
    // against `todayKeyIn`) silently disagreed whenever the wall clock
    // moved past the injected instant.
    const instants = [
      // Mid-afternoon UTC — same calendar day in every zone tested.
      new Date("2026-05-09T15:30:00Z"),
      // Just-past-midnight UTC — Auckland is already on the next day.
      new Date("2026-05-10T00:05:00Z"),
      // Late UTC evening — Los Angeles still on the previous day.
      new Date("2026-05-09T23:50:00Z"),
    ];
    const zones = [
      "America/Los_Angeles", // west of UTC
      "Europe/London", // ~UTC (BST in May)
      "Asia/Tokyo", // east of UTC
      "Pacific/Auckland", // far east of UTC
    ];
    for (const now of instants) {
      for (const tz of zones) {
        const start = startOfTodayInTz(tz, now);
        expect(localDateKey(start, tz)).toBe(todayKeyIn(tz, now));
      }
    }
  });

  test("returns an instant strictly <= now", () => {
    const now = new Date("2026-05-09T15:30:00Z");
    for (const tz of ["America/New_York", "Asia/Tokyo", "UTC"]) {
      const start = startOfTodayInTz(tz, now);
      expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
    }
  });
});

describe("apiToPeriods", () => {
  test("re-keys API buckets to local-tz YYYY-MM-DD", () => {
    // API bucket for May 9 in Chicago arrives as that day's local
    // midnight expressed in UTC: 2026-05-09T05:00:00Z.
    const result = apiToPeriods(
      {
        interval: "day",
        points: [
          { bucket: "2026-05-09T05:00:00.000Z", wins: 3, losses: 1, total: 4, winRate: 0.75 },
        ],
      },
      "America/Chicago",
    );
    expect(result).toEqual([
      { date: "2026-05-09", games: 4, wins: 3, losses: 1, winRate: 0.75 },
    ]);
  });
});
