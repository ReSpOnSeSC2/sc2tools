import { describe, expect, it, vi } from "vitest";
import {
  fmtPlaytime,
  fmtDateCompact,
  macroScoreTone,
  PLAYTIME_FORMAT_OPTIONS,
  type PlaytimeFormat,
} from "../format";

it.each([[null, "text-text-dim"], [59, "text-danger"], [60, "text-warning"], [79, "text-warning"], [80, "text-success"], [Number.NaN, "text-text-dim"]])("uses shared macro score bands for %s", (score, tone) => {
  expect(macroScoreTone(score as number | null)).toBe(tone);
});

it("formats compact replay dates in en-US with the year for older games", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 23, 12));
  try {
    expect(fmtDateCompact(new Date(2026, 9, 21, 20, 42).toISOString())).toBe("Oct 21, 8:42 PM");
    expect(fmtDateCompact(new Date(2025, 2, 3, 20, 42).toISOString())).toBe("Mar 3, 2025, 8:42 PM");
    for (const value of [null, undefined, "", "invalid-date", Number.NaN]) expect(fmtDateCompact(value)).toBe("—");
  } finally { vi.useRealTimers(); }
});

describe("fmtPlaytime", () => {
  it("exposes the five stable dropdown values and human-readable labels", () => {
    expect(PLAYTIME_FORMAT_OPTIONS).toEqual([
      { value: "weeks", label: "Weeks" },
      { value: "days", label: "Days" },
      { value: "hours", label: "Hours" },
      { value: "hoursMinutes", label: "Hours and minutes" },
      { value: "minutesSeconds", label: "Minutes and seconds" },
    ]);
  });

  it.each<[PlaytimeFormat, string]>([
    ["weeks", "0 weeks"],
    ["days", "0 days"],
    ["hours", "0 hours"],
    ["hoursMinutes", "0h 0m"],
    ["minutesSeconds", "0m 0s"],
  ])("formats zero in %s mode", (format, expected) => {
    expect(fmtPlaytime(0, format)).toBe(expected);
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "returns an em dash for invalid seconds %p",
    (seconds) => {
      expect(fmtPlaytime(seconds, "hours")).toBe("—");
    },
  );

  it("uses singular and plural decimal-unit labels", () => {
    expect(fmtPlaytime(7 * 24 * 60 * 60, "weeks")).toBe("1 week");
    expect(fmtPlaytime(2 * 7 * 24 * 60 * 60, "weeks")).toBe("2 weeks");
    expect(fmtPlaytime(24 * 60 * 60, "days")).toBe("1 day");
    expect(fmtPlaytime(2 * 24 * 60 * 60, "days")).toBe("2 days");
    expect(fmtPlaytime(60 * 60, "hours")).toBe("1 hour");
    expect(fmtPlaytime(2 * 60 * 60, "hours")).toBe("2 hours");
  });

  it("keeps large totals readable without capping their leading unit", () => {
    expect(fmtPlaytime(1_234.5 * 60 * 60, "hours")).toBe(
      "1,234.5 hours",
    );
    expect(fmtPlaytime(1_234 * 60 + 5, "minutesSeconds")).toBe(
      "1,234m 5s",
    );
  });

  it("does not hide a tiny nonzero total in decimal modes", () => {
    expect(fmtPlaytime(1, "weeks")).toBe("<0.01 weeks");
    expect(fmtPlaytime(1, "days")).toBe("<0.01 days");
    expect(fmtPlaytime(1, "hours")).toBe("<0.01 hours");
  });

  it("rounds before splitting so seconds and minutes carry cleanly", () => {
    expect(fmtPlaytime(59.6, "minutesSeconds")).toBe("1m 0s");
    expect(fmtPlaytime(3_599.6, "minutesSeconds")).toBe("60m 0s");
    expect(fmtPlaytime(3_599.6, "hoursMinutes")).toBe("1h 0m");
  });

  it("keeps compound totals expressed in total hours or total minutes", () => {
    const seconds = 2 * 60 * 60 + 3 * 60 + 4;
    expect(fmtPlaytime(seconds, "hoursMinutes")).toBe("2h 3m");
    expect(fmtPlaytime(seconds, "minutesSeconds")).toBe("123m 4s");
  });
});
