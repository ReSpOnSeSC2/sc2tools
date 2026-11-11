import { describe, expect, it } from "vitest";
import {
  clearDay,
  copyDay,
  copyLabel,
  copyTargets,
  nextWindow,
  presetsFor,
  replacedDays,
  restoreDays,
} from "./coachingAvailability";
import type { AvailabilityWindow } from "./coachingScheduleModel";

const w = (day: number, start: number, end: number): AvailabilityWindow => ({ day, startMinute: start * 60, endMinute: end * 60 });

describe("copying a day's hours", () => {
  const windows = [w(1, 9, 12), w(1, 13, 17), w(2, 18, 20), w(4, 10, 11), w(6, 10, 14)];

  it("copies to the other weekdays, replacing their hours, and leaves the weekend", () => {
    const targets = copyTargets(1, "weekdays");
    expect(targets).toEqual([2, 3, 4, 5]);
    expect(replacedDays(windows, targets)).toBe(2);
    expect(copyLabel("weekdays", replacedDays(windows, targets))).toBe("Copy to weekdays (replaces 2 days)");
    const next = copyDay(windows, 1, targets);
    for (const day of [1, 2, 3, 4, 5]) expect(next.filter((x) => x.day === day)).toEqual([w(day, 9, 12), w(day, 13, 17)]);
    expect(next.filter((x) => x.day === 6)).toEqual([w(6, 10, 14)]);
    expect(next.some((x) => x.day === 0)).toBe(false);
  });

  it("copies to every other day, and words a copy that replaces nothing plainly", () => {
    const targets = copyTargets(6, "all");
    expect(targets).toEqual([0, 1, 2, 3, 4, 5]);
    expect(copyLabel("all", replacedDays(windows, targets))).toBe("Copy to all days (replaces 3 days)");
    expect(copyLabel("all", 1)).toBe("Copy to all days (replaces 1 day)");
    expect(copyLabel("weekdays", 0)).toBe("Copy to weekdays");
    expect(copyDay(windows, 6, targets)).toEqual([0, 1, 2, 3, 4, 5, 6].map((day) => w(day, 10, 14)));
  });

  it("undoes a copy or a clear by restoring only the touched days", () => {
    const targets = copyTargets(1, "weekdays");
    const previous = windows.filter((x) => targets.includes(x.day));
    const copied = [...copyDay(windows, 1, targets), w(0, 8, 9)];
    expect(restoreDays(copied, previous, targets)).toEqual([w(0, 8, 9), ...windows]);
    const cleared = clearDay(windows, 1);
    expect(cleared.some((x) => x.day === 1)).toBe(false);
    expect(restoreDays(cleared, windows.filter((x) => x.day === 1), [1])).toEqual(windows);
  });
});

describe("presets and Add hours", () => {
  it("offers evenings and afternoons every day, and all day on weekends only", () => {
    expect(presetsFor(3).map((p) => p.label)).toEqual(["Evenings 18:00–22:00", "Afternoons 13:00–17:00"]);
    expect(presetsFor(6).map((p) => p.label)).toEqual(["Evenings 18:00–22:00", "Afternoons 13:00–17:00", "All day 10:00–18:00"]);
    expect(presetsFor(0).at(-1)).toMatchObject({ startMinute: 600, endMinute: 1080 });
  });

  it("adds 18:00–20:00 to an empty day and two hours after the last window otherwise", () => {
    expect(nextWindow([], 2)).toEqual(w(2, 18, 20));
    expect(nextWindow([w(2, 13, 17), w(2, 9, 12)], 2)).toEqual(w(2, 17, 19));
    expect(nextWindow([w(2, 21, 23)], 2)).toEqual(w(2, 23, 24));
    expect(nextWindow([w(2, 18, 24)], 2)).toBeNull();
    expect(nextWindow([1, 2, 3, 4, 5, 6].map((h) => w(2, h, h + 1)), 2)).toBeNull();
  });
});
