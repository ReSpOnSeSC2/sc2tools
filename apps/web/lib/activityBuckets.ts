import { buildWinRateTrend, formatTrendDate, type WinRatePeriod } from "./winRateTrend";

export type ActivityBucket = WinRatePeriod & { end: string; other: number; label: string };
type Interval = "day" | "week" | "month";

function nextPeriod(date: string, interval: Interval): string {
  const value = new Date(`${date}T00:00:00Z`);
  if (interval === "month") value.setUTCMonth(value.getUTCMonth() + 1, 1);
  else value.setUTCDate(value.getUTCDate() + (interval === "week" ? 7 : 1));
  return value.toISOString().slice(0, 10);
}

/** Keep inactive periods visible and combine adjacent periods without losing counts. */
export function buildActivityBuckets(periods: readonly WinRatePeriod[], interval: Interval, maxBars = 32) {
  const normalized = buildWinRateTrend(periods, 1).points;
  if (!normalized.length) return { rows: [] as ActivityBucket[], periodsPerBar: 1 };
  const first = normalized[0].date;
  const last = normalized[normalized.length - 1].date;
  const byDate = new Map(normalized.map((row) => [row.date, row]));
  const calendar: WinRatePeriod[] = [];
  for (let date = first; date <= last; date = nextPeriod(date, interval)) {
    calendar.push(byDate.get(date) ?? { date, wins: 0, losses: 0, games: 0 });
  }
  const periodsPerBar = Math.max(1, Math.ceil(calendar.length / Math.max(1, Math.floor(maxBars))));
  const rows: ActivityBucket[] = [];
  for (let index = 0; index < calendar.length; index += periodsPerBar) {
    const group = calendar.slice(index, index + periodsPerBar);
    const date = group[0].date;
    const end = group[group.length - 1].date;
    const wins = group.reduce((sum, row) => sum + row.wins, 0);
    const losses = group.reduce((sum, row) => sum + row.losses, 0);
    const games = group.reduce((sum, row) => sum + row.games, 0);
    rows.push({ date, end, wins, losses, games, other: Math.max(0, games - wins - losses), label: date === end ? formatTrendDate(date, true) : `${formatTrendDate(date, true)} – ${formatTrendDate(end, true)}` });
  }
  return { rows, periodsPerBar };
}
