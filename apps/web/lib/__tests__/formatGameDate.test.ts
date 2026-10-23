import { afterEach, beforeEach, expect, it } from "vitest";
import { fmtGameDate } from "../format";
const originalTimezone = process.env.TZ;
const now = Date.parse("2026-10-23T21:42:00Z");
beforeEach(() => { process.env.TZ = "UTC"; });
afterEach(() => { process.env.TZ = originalTimezone; });
it("formats recent games without seconds and keeps a fixed clock", () => {
  expect(fmtGameDate("2026-10-23T21:41:50Z", now)).toBe("Oct 23, 2026 · 9:41 PM (just now)");
  expect(fmtGameDate("2026-10-23T21:32:00Z", now)).toContain("(10m ago)");
  expect(fmtGameDate("2026-10-23T18:42:00Z", now)).toContain("(3h ago)");
  expect(fmtGameDate("2026-10-22T21:42:00Z", now)).toContain("(yesterday)");
  expect(fmtGameDate("2026-10-21T21:42:00Z", now)).toBe("Oct 21, 2026 · 9:42 PM (2 days ago)");
  expect(fmtGameDate("2026-09-01T21:42:00Z", now)).toBe("Sep 1, 2026 · 9:42 PM");
  expect(fmtGameDate("invalid", now)).toBe("—"); expect(fmtGameDate(null, now)).toBe("—");
});
