/**
 * Adapter for the cloud `/v1/timeseries` endpoint.
 *
 * The cloud API returns `{ interval, points: [{ bucket, wins, losses, total,
 * winRate }] }`, but the dashboard and Trends tab were originally written
 * against the legacy SPA shape: a flat `Period[]` of
 * `{ date, games, wins, losses, winRate }`. Map the API shape into that
 * legacy shape so the existing UI logic keeps working without rewrites.
 *
 * `bucket` arrives as an ISO string (e.g. `2026-04-01T00:00:00.000Z`) — we
 * slice the date portion so equality checks like `last.date === todayKey`
 * (which uses `YYYY-MM-DD`) match correctly.
 */

export type ApiTimeseriesPoint = {
  bucket: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
};

export type ApiTimeseriesResponse = {
  interval: "day" | "week" | "month";
  points: ApiTimeseriesPoint[];
};

export type Period = {
  date: string;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
};

/**
 * Normalise a `/v1/timeseries` response into the flat `Period[]` shape
 * the existing UI consumers expect. Tolerant of `undefined`, malformed
 * payloads, or the legacy array shape (returned as-is).
 */
export function apiToPeriods(
  data: ApiTimeseriesResponse | Period[] | undefined,
): Period[] {
  if (!data) return [];
  // Legacy SPA shape: already a flat array.
  if (Array.isArray(data)) return data;
  if (!Array.isArray(data.points)) return [];
  return data.points.map((p) => ({
    date: typeof p.bucket === "string" ? p.bucket.slice(0, 10) : "",
    games: p.total ?? 0,
    wins: p.wins ?? 0,
    losses: p.losses ?? 0,
    winRate: p.winRate ?? 0,
  }));
}
