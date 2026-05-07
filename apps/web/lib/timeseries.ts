/**
 * Adapter for the cloud `/v1/timeseries` endpoint.
 *
 * The cloud API returns `{ interval, points: [{ bucket, wins, losses, total,
 * winRate }] }`, but the dashboard and Trends tab were originally written
 * against the legacy SPA shape: a flat `Period[]` of
 * `{ date, games, wins, losses, winRate }`. Map the API shape into that
 * legacy shape so the existing UI logic keeps working without rewrites.
 *
 * `bucket` arrives as an ISO string. When the API buckets in the user's
 * timezone (the default, see `clientTimezone`), the ISO timestamp
 * represents the *start of that day in user-local time* — e.g. for LA
 * on May 6 it comes back as `2026-05-06T07:00:00.000Z`. Slicing the UTC
 * date portion would mis-key Sydney users by a day, so we format the
 * Date back into the user's timezone explicitly.
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
 * Detect the browser's IANA timezone (e.g. `America/Los_Angeles`).
 * Falls back to `UTC` on the server or in environments without ICU.
 */
export function clientTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && typeof tz === "string") return tz;
  } catch {
    /* ignore — fall through to UTC */
  }
  return "UTC";
}

/**
 * Format an ISO timestamp (or Date) as `YYYY-MM-DD` in the supplied
 * timezone. Used to derive bucket keys that align with what a user
 * would call "today" / "yesterday" in their own clock.
 */
export function localDateKey(value: string | Date, timeZone: string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  // `en-CA` happens to format as YYYY-MM-DD, which keeps the keys
  // sortable and matches the legacy SPA shape.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

/**
 * Today's date in the user's timezone, formatted as `YYYY-MM-DD`.
 */
export function todayKeyIn(timeZone: string): string {
  return localDateKey(new Date(), timeZone);
}

/**
 * Normalise a `/v1/timeseries` response into the flat `Period[]` shape
 * the existing UI consumers expect. Tolerant of `undefined`, malformed
 * payloads, or the legacy array shape (returned as-is).
 *
 * `timeZone` should match the `tz` query param the response was
 * generated with — when omitted the browser's timezone is used so the
 * keys line up with `todayKeyIn(clientTimezone())`.
 */
export function apiToPeriods(
  data: ApiTimeseriesResponse | Period[] | undefined,
  timeZone: string = clientTimezone(),
): Period[] {
  if (!data) return [];
  // Legacy SPA shape: already a flat array.
  if (Array.isArray(data)) return data;
  if (!Array.isArray(data.points)) return [];
  return data.points.map((p) => ({
    date: typeof p.bucket === "string" ? localDateKey(p.bucket, timeZone) : "",
    games: p.total ?? 0,
    wins: p.wins ?? 0,
    losses: p.losses ?? 0,
    winRate: p.winRate ?? 0,
  }));
}
