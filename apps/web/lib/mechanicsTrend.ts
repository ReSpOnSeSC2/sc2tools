import type { Period } from "./timeseries";

export type MechanicsMetric = "macro" | "apm" | "sq";
export type MechanicsBucket = "day" | "week" | "month";
export const MECHANICS_METRICS = {
  macro: { label: "Macro score", value: "avgMacroScore", count: "macroN", description: "A fixed score from 0 to 100 for recorded macro habits. Higher is cleaner macro." },
  apm: { label: "APM", value: "avgApm", count: "apmN", description: "Recorded actions per minute. More actions alone do not establish better play." },
  sq: { label: "SQ", value: "avgSpq", count: "spqN", description: "Spending quotient relates resource spending to income. It is separate from the macro score." },
} as const;
export const isMechanicsBucket = (value: unknown): value is MechanicsBucket => value === "day" || value === "week" || value === "month";
export type MechanicsPoint = { date: string; time: number; value: number | null; n: number | null; hollow: boolean; breakBefore: boolean };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const dateTime = (key: string) => {
  const time = /^\d{4}-\d{2}-\d{2}$/.test(key) ? Date.parse(`${key}T00:00:00Z`) : NaN;
  return finite(time) && new Date(time).toISOString().slice(0, 10) === key ? time : NaN;
};
function nextPeriod(time: number, bucket: MechanicsBucket) {
  const date = new Date(time);
  if (bucket === "month") date.setUTCMonth(date.getUTCMonth() + 1);
  else date.setUTCDate(date.getUTCDate() + (bucket === "week" ? 7 : 1));
  return date.getTime();
}

/** Calendar positions are based on local date keys, independent of DST hours.
 * A missing calendar bucket or missing metric interrupts the observed line. */
export function mechanicsPoints(series: readonly Period[], metric: MechanicsMetric, bucket: MechanicsBucket): MechanicsPoint[] {
  const keys = MECHANICS_METRICS[metric];
  const ordered = series.map(row => ({ row, time: dateTime(row.date) })).filter(row => finite(row.time)).sort((a, b) => a.time - b.time);
  return ordered.map(({ row, time }, index) => {
    const average = row[keys.value], count = row[keys.count];
    const n = finite(count) && Number.isInteger(count) && count >= 0 ? count : null;
    const value = finite(average) && average >= 0 && (metric !== "macro" || average <= 100) && n !== 0 ? average : null;
    return { date: row.date, time, value, n, hollow: n === null || n < 5, breakBefore: index > 0 && time > nextPeriod(ordered[index - 1].time, bucket) };
  });
}

export function mechanicsGeometry(points: readonly MechanicsPoint[], metric: MechanicsMetric, reference: number | null = null, width = 640) {
  const measured = points.filter(row => row.value !== null);
  const min = points[0]?.time ?? 0, max = points.at(-1)?.time ?? min;
  const upper = metric === "macro" ? 100 : Math.max(10, Math.ceil(Math.max(...measured.map(row => row.value!), reference ?? 0, 0) / 10) * 10);
  const x = (time: number) => max === min ? width / 2 : 44 + (time - min) / (max - min) * (width - 64);
  const y = (value: number) => 190 - value / upper * 160;
  let path = "", connected = false;
  for (const point of points) {
    if (point.value === null) { connected = false; continue; }
    path += `${connected && !point.breakBefore ? "L" : "M"}${x(point.time)},${y(point.value)} `;
    connected = true;
  }
  return { upper, x, y, path: path.trim() };
}
