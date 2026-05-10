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
      expect(localDateKey(start, tz)).toBe(todayKeyIn(tz));
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
