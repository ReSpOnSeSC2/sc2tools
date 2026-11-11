import { compareWindows } from "./coachingTime";
import type { AvailabilityWindow } from "./coachingScheduleModel";

/**
 * Faster weekly-hours editing: copy one day's windows to the weekdays or
 * every day, clear a day, undo either, start an empty day from a preset,
 * and add the next slot after a day's last window.
 */

export const DAY_MINUTES = 24 * 60;
export const MAX_WINDOWS_PER_DAY = 6;
export const UNDO_MS = 10_000;

const WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];
const ALL_DAYS: readonly number[] = [0, 1, 2, 3, 4, 5, 6];

export type CopyScope = "weekdays" | "all";

export function copyTargets(sourceDay: number, scope: CopyScope): number[] {
  return (scope === "weekdays" ? WEEKDAYS : ALL_DAYS).filter((day) => day !== sourceDay);
}

/** How many target days already have hours that a copy would replace. */
export function replacedDays(windows: readonly AvailabilityWindow[], targets: readonly number[]): number {
  return targets.filter((day) => windows.some((window) => window.day === day)).length;
}

export function copyLabel(scope: CopyScope, replaced: number): string {
  const base = scope === "weekdays" ? "Copy to weekdays" : "Copy to all days";
  return replaced ? `${base} (replaces ${replaced} day${replaced === 1 ? "" : "s"})` : base;
}

/** The targets' windows become exact copies of the source day's. */
export function copyDay(windows: readonly AvailabilityWindow[], sourceDay: number, targets: readonly number[]): AvailabilityWindow[] {
  const source = windows.filter((window) => window.day === sourceDay);
  const kept = windows.filter((window) => !targets.includes(window.day));
  const copies = targets.flatMap((day) => source.map((window) => ({ day, startMinute: window.startMinute, endMinute: window.endMinute })));
  return [...kept, ...copies].sort(compareWindows);
}

export function clearDay(windows: readonly AvailabilityWindow[], day: number): AvailabilityWindow[] {
  return windows.filter((window) => window.day !== day);
}

/** Undo puts back exactly the touched days' earlier windows. */
export function restoreDays(windows: readonly AvailabilityWindow[], previous: readonly AvailabilityWindow[], days: readonly number[]): AvailabilityWindow[] {
  return [
    ...windows.filter((window) => !days.includes(window.day)),
    ...previous.filter((window) => days.includes(window.day)).map((window) => ({ ...window })),
  ].sort(compareWindows);
}

export type DayPreset = { id: string; label: string; startMinute: number; endMinute: number };

export function presetsFor(day: number): DayPreset[] {
  const presets: DayPreset[] = [
    { id: "evenings", label: "Evenings 18:00–22:00", startMinute: 18 * 60, endMinute: 22 * 60 },
    { id: "afternoons", label: "Afternoons 13:00–17:00", startMinute: 13 * 60, endMinute: 17 * 60 },
  ];
  if (day === 0 || day === 6) presets.push({ id: "all-day", label: "All day 10:00–18:00", startMinute: 10 * 60, endMinute: 18 * 60 });
  return presets;
}

/**
 * "Add hours": two hours after the day's last window, ending by 24:00, or
 * 18:00–20:00 on an empty day. Null when the day has no room left.
 */
export function nextWindow(windows: readonly AvailabilityWindow[], day: number): AvailabilityWindow | null {
  const sameDay = windows.filter((window) => window.day === day);
  if (sameDay.length >= MAX_WINDOWS_PER_DAY) return null;
  const ends = sameDay.map((window) => window.endMinute).filter(Number.isFinite);
  if (!ends.length) return { day, startMinute: 18 * 60, endMinute: 20 * 60 };
  const startMinute = Math.ceil(Math.max(...ends) / 30) * 30;
  const endMinute = Math.min(startMinute + 120, DAY_MINUTES);
  return endMinute - startMinute >= 30 ? { day, startMinute, endMinute } : null;
}
