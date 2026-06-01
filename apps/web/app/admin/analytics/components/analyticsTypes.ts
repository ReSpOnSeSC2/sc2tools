/**
 * Response shapes for the admin Analytics tab, mirroring the payloads
 * returned by ``GET /v1/admin/analytics/summary`` and ``/realtime``.
 * Kept in one module so the page and its chart/table components share a
 * single definition.
 */

/** Headline metrics for a period (also the per-day series shape). */
export type AnalyticsTotals = {
  activeUsers: number;
  newUsers: number;
  sessions: number;
  screenPageViews: number;
  /** 0..1 — share of engaged sessions. */
  engagementRate: number;
  /** Seconds. */
  averageSessionDuration: number;
};

export type TimeseriesPoint = AnalyticsTotals & { date: string };

export type TopPage = {
  path: string;
  title: string;
  views: number;
  activeUsers: number;
};

export type ChannelRow = {
  channel: string;
  sessions: number;
  activeUsers: number;
};

export type DeviceRow = {
  device: string;
  activeUsers: number;
  sessions: number;
};

export type CountryRow = {
  country: string;
  activeUsers: number;
};

/** Percentage change per headline metric vs the prior period (null = n/a). */
export type AnalyticsDeltas = Partial<Record<keyof AnalyticsTotals, number | null>>;

export type AnalyticsSummary = {
  configured: true;
  range: { days: number; startDate: string; endDate: string };
  totals: AnalyticsTotals;
  previous: AnalyticsTotals;
  deltas: AnalyticsDeltas;
  timeseries: TimeseriesPoint[];
  topPages: TopPage[];
  channels: ChannelRow[];
  devices: DeviceRow[];
  countries: CountryRow[];
};

/** The API returns ``{ configured: false }`` when GA isn't wired up. */
export type AnalyticsSummaryResp = AnalyticsSummary | { configured: false };

export type RealtimeResp =
  | { configured: false }
  | { configured: true; activeUsers: number; byCountry: CountryRow[] };

/** Narrowing helper used by the page + components. */
export function isConfigured(
  resp: AnalyticsSummaryResp | undefined,
): resp is AnalyticsSummary {
  return Boolean(resp && resp.configured);
}
