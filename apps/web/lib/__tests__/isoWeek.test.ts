import { expect, it } from "vitest";
import { formatWeekRange, shiftWeekKey, weekKeyToRange } from "../isoWeek";

it("formats same-month, cross-month and cross-year ranges without timezone drift", () => {
  expect(formatWeekRange("2026-W42")).toBe("Oct 12 – 18, 2026");
  expect(formatWeekRange("2025-W40")).toBe("Sep 29 – Oct 5, 2025");
  expect(formatWeekRange("2026-W01")).toBe("Dec 29, 2025 – Jan 4, 2026");
});
it("shifts correctly through week 53 and the ISO year boundary", () => {
  expect(shiftWeekKey("2020-W53", 1)).toBe("2021-W01");
  expect(shiftWeekKey("2021-W01", -1)).toBe("2020-W53");
  expect(weekKeyToRange("2020-W53")?.start.toISOString()).toBe("2020-12-28T00:00:00.000Z");
});
it.each(["2021-W53", "2026-W00", "2026-W54", "nonsense"])("rejects nonexistent weeks: %s", (key) => expect(weekKeyToRange(key)).toBeNull());
