import { expect, it } from "vitest";
import { communityDescription } from "./communityDescription";
import { fmtDay, fmtMonthYear } from "./format";

it("summarizes only the first paragraph without cutting a word", () => {
  const text = "Scouting and a safe opening. ".repeat(12) + "\n\nKeep this second paragraph.";
  const result = communityDescription(text);
  expect(result.showAbout).toBe(true); expect(result.summary.length).toBeLessThanOrEqual(161);
  expect(result.summary.endsWith("…")).toBe(true); expect(text.startsWith(result.summary.slice(0, -1))).toBe(true);
  expect(result.summary).not.toContain("second paragraph");
  expect(communityDescription("Short summary")).toEqual({ summary: "Short summary", showAbout: false });
  expect(communityDescription("Short\n\nMore")).toEqual({ summary: "Short", showAbout: true });
  expect(communityDescription(undefined)).toEqual({ summary: "", showAbout: false });
});

it("formats public dates and publishing month consistently in UTC", () => {
  expect(fmtDay("2026-10-03T23:30:00Z")).toBe("Oct 3, 2026");
  expect(fmtDay("2026-10-04T01:30:00+02:00")).toBe("Oct 3, 2026");
  expect(fmtMonthYear("2026-03-01T00:30:00Z")).toBe("Mar 2026");
  expect(fmtDay("invalid")).toBe("—"); expect(fmtMonthYear(null)).toBe("—");
});
