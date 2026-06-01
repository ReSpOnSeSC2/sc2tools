"use client";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

import { Card } from "@/components/ui/Card";
import { compactNumber } from "../../components/format";
import type {
  AnalyticsDeltas,
  AnalyticsTotals,
  ChannelRow,
  CountryRow,
  DeviceRow,
  TimeseriesPoint,
  TopPage,
} from "./analyticsTypes";

/**
 * Presentational sections for the admin Analytics tab — KPI cards, the
 * traffic timeseries chart, and the breakdown tables. All data is the
 * real GA4 payload passed down from the page; these components never
 * fetch or fabricate.
 */

const COLOR_GRID = "#1f2533";
const COLOR_TEXT_DIM = "#6b7280";
const COLOR_USERS = "#22d3ee"; // accent-cyan-ish
const COLOR_SESSIONS = "#7c8cff"; // accent

// ---- KPI cards -------------------------------------------------------

type KpiDef = {
  key: keyof AnalyticsTotals;
  label: string;
  format: (n: number) => string;
};

const KPIS: ReadonlyArray<KpiDef> = [
  { key: "activeUsers", label: "Active users", format: compactNumber },
  { key: "newUsers", label: "New users", format: compactNumber },
  { key: "sessions", label: "Sessions", format: compactNumber },
  { key: "screenPageViews", label: "Page views", format: compactNumber },
  { key: "engagementRate", label: "Engagement rate", format: formatRate },
  { key: "averageSessionDuration", label: "Avg. session", format: formatDuration },
];

export function KpiGrid({
  totals,
  deltas,
}: {
  totals: AnalyticsTotals;
  deltas: AnalyticsDeltas;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {KPIS.map((kpi) => (
        <KpiCard
          key={kpi.key}
          label={kpi.label}
          value={kpi.format(totals[kpi.key])}
          delta={deltas[kpi.key] ?? null}
        />
      ))}
    </div>
  );
}

function KpiCard({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  delta: number | null;
}) {
  return (
    <Card padded>
      <div className="flex flex-col gap-1">
        <span className="text-caption font-semibold uppercase tracking-wider text-text-dim">
          {label}
        </span>
        <span className="text-2xl font-semibold tabular-nums text-text">
          {value}
        </span>
        <DeltaBadge delta={delta} />
      </div>
    </Card>
  );
}

function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta === null || !Number.isFinite(delta)) {
    return <span className="text-caption text-text-dim">vs prev. period</span>;
  }
  const up = delta >= 0;
  const tone = delta === 0 ? "text-text-dim" : up ? "text-success" : "text-danger";
  const arrow = delta === 0 ? "▬" : up ? "▲" : "▼";
  return (
    <span className={`text-caption tabular-nums ${tone}`}>
      {arrow} {Math.abs(delta)}%{" "}
      <span className="text-text-dim">vs prev.</span>
    </span>
  );
}

// ---- traffic timeseries ---------------------------------------------

export function TrafficChart({ points }: { points: TimeseriesPoint[] }) {
  if (points.length === 0) {
    return (
      <Card title="Traffic over time">
        <p className="py-8 text-center text-caption text-text-dim">
          No sessions recorded in this window yet.
        </p>
      </Card>
    );
  }
  return (
    <Card title="Traffic over time" right={<ChartLegend />}>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            <defs>
              <linearGradient id="ga-users" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLOR_USERS} stopOpacity={0.35} />
                <stop offset="100%" stopColor={COLOR_USERS} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="ga-sessions" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLOR_SESSIONS} stopOpacity={0.3} />
                <stop offset="100%" stopColor={COLOR_SESSIONS} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={COLOR_GRID} />
            <XAxis
              dataKey="date"
              stroke={COLOR_TEXT_DIM}
              fontSize={11}
              tickFormatter={(v) => formatDateTick(String(v))}
              minTickGap={28}
              tickMargin={6}
            />
            <YAxis
              stroke={COLOR_TEXT_DIM}
              fontSize={11}
              width={40}
              allowDecimals={false}
            />
            <Tooltip content={<TrafficTooltip />} />
            <Area
              type="monotone"
              dataKey="activeUsers"
              stroke={COLOR_USERS}
              strokeWidth={2}
              fill="url(#ga-users)"
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="sessions"
              stroke={COLOR_SESSIONS}
              strokeWidth={2}
              fill="url(#ga-sessions)"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function ChartLegend() {
  return (
    <div className="flex items-center gap-3 text-micro">
      <LegendDot color={COLOR_USERS} label="Active users" />
      <LegendDot color={COLOR_SESSIONS} label="Sessions" />
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1 text-text-muted">
      <span
        aria-hidden
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}

type TooltipProps = {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ dataKey?: string | number; value?: number | string }>;
};

function TrafficTooltip({ active, label, payload }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const get = (key: string) =>
    payload.find((p) => p.dataKey === key)?.value ?? 0;
  return (
    <div className="rounded-lg border border-border bg-bg-surface px-3 py-2 text-caption shadow-lg">
      <div className="mb-1 font-semibold text-text">
        {formatDateTick(String(label), true)}
      </div>
      <div className="flex items-center justify-between gap-4 text-text-muted">
        <span>Active users</span>
        <span className="tabular-nums text-text">{get("activeUsers")}</span>
      </div>
      <div className="flex items-center justify-between gap-4 text-text-muted">
        <span>Sessions</span>
        <span className="tabular-nums text-text">{get("sessions")}</span>
      </div>
    </div>
  );
}

// ---- breakdown tables -----------------------------------------------

export function TopPagesTable({ rows }: { rows: TopPage[] }) {
  return (
    <BreakdownCard title="Top pages" empty="No page views yet.">
      {rows.length > 0 ? (
        <table className="w-full text-sm">
          <thead className="bg-bg-elevated/40 text-left text-caption uppercase tracking-wider text-text-dim">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Page</th>
              <th className="px-4 py-2.5 text-right font-semibold">Views</th>
              <th className="px-4 py-2.5 text-right font-semibold">Users</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.path} className="hover:bg-bg-elevated/30">
                <td className="max-w-0 px-4 py-2">
                  <div className="truncate font-mono text-text" title={row.path}>
                    {row.path}
                  </div>
                  {row.title ? (
                    <div className="truncate text-caption text-text-dim" title={row.title}>
                      {row.title}
                    </div>
                  ) : null}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-text">
                  {compactNumber(row.views)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                  {compactNumber(row.activeUsers)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </BreakdownCard>
  );
}

/** Shared horizontal-bar list for channels / devices / countries. */
export function BarBreakdown({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<{ label: string; value: number }>;
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0);
  return (
    <BreakdownCard title={title} empty={empty}>
      {rows.length > 0 ? (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.label} className="px-4 py-2.5">
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="truncate text-body text-text" title={row.label}>
                  {row.label}
                </span>
                <span className="tabular-nums text-caption text-text-muted">
                  {compactNumber(row.value)}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-elevated">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${max > 0 ? (row.value / max) * 100 : 0}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </BreakdownCard>
  );
}

export function channelsToRows(channels: ChannelRow[]) {
  return channels.map((c) => ({ label: c.channel, value: c.sessions }));
}

export function devicesToRows(devices: DeviceRow[]) {
  return devices.map((d) => ({ label: d.device, value: d.activeUsers }));
}

export function countriesToRows(countries: CountryRow[]) {
  return countries.map((c) => ({ label: c.country, value: c.activeUsers }));
}

function BreakdownCard({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  const hasContent = Boolean(children);
  return (
    <Card padded={false}>
      <Card.Header>
        <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
          {title}
        </h3>
      </Card.Header>
      {hasContent ? (
        children
      ) : (
        <p className="px-4 py-6 text-caption text-text-dim">{empty}</p>
      )}
    </Card>
  );
}

// ---- formatters ------------------------------------------------------

/** 0..1 → "57%". */
function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return "—";
  return `${Math.round(rate * 100)}%`;
}

/** Seconds → "m:ss" (or "h:mm" past an hour). */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** "2026-05-31" → "May 31". */
function formatDateTick(value: string, withYear = false): string {
  if (!value || value.length < 10) return value;
  const [y, m, d] = value.split("-");
  const idx = Number.parseInt(m, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx > 11) return value;
  const day = Number.parseInt(d, 10);
  return withYear ? `${MONTHS[idx]} ${day}, ${y}` : `${MONTHS[idx]} ${day}`;
}
