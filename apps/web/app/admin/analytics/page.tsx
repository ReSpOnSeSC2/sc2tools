"use client";

import { useState } from "react";

import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { compactNumber } from "../components/format";
import { ForbiddenCard, LoadingRows } from "../components/AdminFragments";
import {
  BarBreakdown,
  KpiGrid,
  TopPagesTable,
  TrafficChart,
  channelsToRows,
  countriesToRows,
  devicesToRows,
} from "./components/AnalyticsSections";
import { isConfigured } from "./components/analyticsTypes";
import type {
  AnalyticsSummaryResp,
  RealtimeResp,
} from "./components/analyticsTypes";

/**
 * /admin/analytics — Google Analytics 4 dashboard.
 *
 * Reads the GA4 Data API server-side through ``/v1/admin/analytics/*``
 * (the browser never touches Google directly, and no measurement
 * secrets ship to the client). Everything rendered here is the live GA
 * payload — KPI cards with prior-period deltas, a daily traffic chart,
 * and top pages / channels / devices / countries.
 *
 * Degrades gracefully:
 *   - 403 → the shared ForbiddenCard (non-admin hitting the URL).
 *   - ``configured: false`` → a setup hint instead of an error, so the
 *     tab is safe to ship before GA credentials are wired up.
 */

const RANGE_OPTIONS = [
  { days: 7, label: "7d" },
  { days: 28, label: "28d" },
  { days: 90, label: "90d" },
] as const;

const REALTIME_REFRESH_MS = 60_000;

export default function AdminAnalyticsPage() {
  const [days, setDays] = useState<number>(28);
  const summary = useApi<AnalyticsSummaryResp>(
    `/v1/admin/analytics/summary?days=${days}`,
  );
  const realtime = useApi<RealtimeResp>("/v1/admin/analytics/realtime", {
    refreshInterval: REALTIME_REFRESH_MS,
  });

  if (summary.error?.status === 403) return <ForbiddenCard />;

  const data = summary.data;
  const notConfigured = data !== undefined && !data.configured;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold">Analytics</h1>
          <p className="text-text-muted">
            Live Google Analytics 4 traffic for sc2tools.com — visitors,
            sessions, top pages, and acquisition.
          </p>
        </div>
        <RangePicker
          value={days}
          onChange={setDays}
          disabled={notConfigured}
        />
      </header>

      <RealtimeBanner data={realtime.data} />

      {summary.error && summary.error.status !== 403 ? (
        <Card padded>
          <p className="text-danger">
            Failed to load analytics: {summary.error.message}
          </p>
        </Card>
      ) : notConfigured ? (
        <NotConfiguredCard />
      ) : !isConfigured(data) ? (
        <AnalyticsSkeleton />
      ) : (
        <>
          <KpiGrid totals={data.totals} deltas={data.deltas} />
          <TrafficChart points={data.timeseries} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <TopPagesTable rows={data.topPages} />
            <BarBreakdown
              title="Acquisition channels"
              empty="No sessions yet."
              rows={channelsToRows(data.channels)}
            />
            <BarBreakdown
              title="Devices"
              empty="No device data yet."
              rows={devicesToRows(data.devices)}
            />
            <BarBreakdown
              title="Top countries"
              empty="No country data yet."
              rows={countriesToRows(data.countries)}
            />
          </div>
          <p className="text-caption text-text-dim">
            Window: {data.range.startDate} → {data.range.endDate}. GA processes
            most metrics within 24–48h, so the most recent day may still be
            settling.
          </p>
        </>
      )}
    </div>
  );
}

function RangePicker({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (days: number) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-1 rounded-lg border border-border bg-bg-surface p-1"
      role="group"
      aria-label="Date range"
    >
      {RANGE_OPTIONS.map((opt) => (
        <button
          key={opt.days}
          type="button"
          disabled={disabled}
          onClick={() => onChange(opt.days)}
          className={[
            "rounded-md px-3 py-1 text-caption font-semibold transition-colors disabled:opacity-40",
            value === opt.days
              ? "bg-accent/20 text-accent ring-1 ring-accent/40"
              : "text-text-muted hover:text-text",
          ].join(" ")}
          aria-pressed={value === opt.days}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function RealtimeBanner({ data }: { data: RealtimeResp | undefined }) {
  if (!data || !data.configured) return null;
  return (
    <Card padded>
      <div className="flex items-center gap-3">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/70" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success" />
        </span>
        <span className="text-2xl font-semibold tabular-nums text-text">
          {compactNumber(data.activeUsers)}
        </span>
        <span className="text-caption text-text-muted">
          active in the last 30 minutes
          {data.byCountry.length > 0
            ? ` · top: ${data.byCountry[0].country}`
            : ""}
        </span>
      </div>
    </Card>
  );
}

function NotConfiguredCard() {
  return (
    <Card padded>
      <div className="space-y-3">
        <span className="inline-flex items-center gap-2 rounded-full bg-warning/15 px-3 py-1 text-caption font-semibold text-warning">
          Not configured yet
        </span>
        <p className="text-text-muted">
          The Google Analytics Data API isn&apos;t wired up on the server. Set{" "}
          <code className="font-mono text-text">GA4_PROPERTY_ID</code> and{" "}
          <code className="font-mono text-text">GA_SERVICE_ACCOUNT_KEY_B64</code>{" "}
          in the API environment, grant the service account{" "}
          <span className="font-medium text-text">Viewer</span> access to the GA4
          property, then reload. The tracking tag on the public site works
          independently of this dashboard.
        </p>
      </div>
    </Card>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-bg-elevated" />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-xl bg-bg-elevated" />
      <LoadingRows rows={6} />
    </div>
  );
}
