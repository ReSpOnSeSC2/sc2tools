import { weekKey } from "@/components/analyzer/arcade/ArcadeEngine";

/** Calendar dates are UTC containers, so formatting cannot shift a day by timezone. */
export function weekKeyToRange(key: string): { start: Date; end: Date } | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]); const week = Number(match[2]);
  if (week < 1 || week > 53) return null;
  const start = new Date(Date.UTC(year, 0, 4));
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7 + (week - 1) * 7);
  if (weekKey(start, "UTC") !== key) return null;
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
  return { start, end };
}

export function shiftWeekKey(key: string, direction: -1 | 1): string {
  const range = weekKeyToRange(key);
  if (!range) throw new Error("Invalid ISO week");
  range.start.setUTCDate(range.start.getUTCDate() + direction * 7);
  return weekKey(range.start, "UTC");
}

export function formatWeekRange(key: string): string {
  const range = weekKeyToRange(key);
  if (!range) return "Invalid week";
  const { start, end } = range;
  const month = (date: Date) => new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);
  if (start.getUTCFullYear() !== end.getUTCFullYear()) return `${month(start)} ${start.getUTCDate()}, ${start.getUTCFullYear()} – ${month(end)} ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
  if (start.getUTCMonth() !== end.getUTCMonth()) return `${month(start)} ${start.getUTCDate()} – ${month(end)} ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
  return `${month(start)} ${start.getUTCDate()} – ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
}
