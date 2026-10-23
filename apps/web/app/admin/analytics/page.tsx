"use client";

import { useState } from "react";
import { ActivationPanel } from "../components/ActivationPanel";

import { useApi } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { AdminPageHeader as PageHeader } from "@/app/admin/components/AdminPageHeader";
import { RequestError } from "@/components/ui/RequestError";
import { AnalyticsRangePicker } from "./components/AnalyticsRangePicker";
import { downloadCsv } from "./components/analyticsExport";
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

const REALTIME_REFRESH_MS = 60_000;

export default function AdminAnalyticsPage() {
  const [tab,setTab]=useState<"traffic"|"activation">("traffic");
  return <div className="space-y-4"><div role="group" aria-label="Analytics view" className="flex gap-2"><Button variant={tab==="traffic"?"primary":"secondary"} aria-pressed={tab==="traffic"} onClick={()=>setTab("traffic")}>Web traffic</Button><Button variant={tab==="activation"?"primary":"secondary"} aria-pressed={tab==="activation"} onClick={()=>setTab("activation")}>Activation</Button></div>{tab==="activation"?<ActivationPanel/>:<TrafficAnalytics/>}</div>;
}

function TrafficAnalytics() {
  const [days, setDays] = useState<number | "custom">(28);
  const [rangeQuery, setRangeQuery] = useState("days=28");
  const summary = useApi<AnalyticsSummaryResp>(
    `/v1/admin/analytics/summary?${rangeQuery}`,
  );
  const realtime = useApi<RealtimeResp>("/v1/admin/analytics/realtime", {
    refreshInterval: REALTIME_REFRESH_MS,
  });

  if (summary.error?.status === 403 || realtime.error?.status === 403) return <ForbiddenCard />;

  const data = summary.data;
  const notConfigured = data !== undefined && !data.configured;

  return (
    <div className="space-y-6">
      <PageHeader anchor="web-analytics-ga4-setup" eyebrow="Admin" title="Web analytics" description="Visitors, sessions, top pages and acquisition from Google Analytics 4." />
      <AnalyticsRangePicker value={days} disabled={notConfigured}
        onPreset={(next) => { setDays(next); setRangeQuery("days=" + next); }}
        onCustom={(from, to) => { setDays("custom"); setRangeQuery("from=" + from + "&to=" + to); }} />
      {realtime.error ? <p className="text-caption text-text-muted">Realtime unavailable · <Button variant="ghost" size="sm" loading={realtime.isValidating} onClick={() => void realtime.mutate()}>Retry</Button></p> : null}

      <RealtimeBanner data={realtime.data} />

      {summary.error && summary.error.status !== 403 ? (
        <RequestError title="Analytics could not load" error={summary.error} onRetry={() => summary.mutate()} />
      ) : notConfigured ? (
        <NotConfiguredCard />
      ) : !isConfigured(data) ? (
        <AnalyticsSkeleton />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => exportAnalytics(data, "top-pages")}>Export CSV: top pages</Button>
            <Button variant="secondary" size="sm" onClick={() => exportAnalytics(data, "channels")}>Export CSV: channels</Button>
          </div>
          <KpiGrid totals={data.totals} deltas={data.deltas} />
          <TrafficChart points={data.timeseries} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <TopPagesTable rows={data.topPages} total={data.totals.screenPageViews} />
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

function exportAnalytics(data: import("./components/analyticsTypes").AnalyticsSummary, kind: "top-pages" | "channels") {
  const to = /^\d{4}-/.test(data.range.endDate) ? data.range.endDate : new Date().toISOString().slice(0, 10);
  const from = /^\d{4}-/.test(data.range.startDate) ? data.range.startDate : new Date(Date.parse(to) - (data.range.days - 1) * 86400000).toISOString().slice(0, 10);
  const rows = kind === "top-pages"
    ? [["Page", "Title", "Views", "Users"], ...data.topPages.map((row) => [row.path, row.title, row.views, row.activeUsers])]
    : [["Channel", "Sessions", "Users"], ...data.channels.map((row) => [row.channel, row.sessions, row.activeUsers])];
  downloadCsv("analytics-" + kind + "-" + from + "_to_" + to + ".csv", rows);
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
        <a className="text-accent-cyan underline" href="https://github.com/ReSpOnSeSC2/sc2tools/blob/main/docs/admin-console.md#web-analytics-ga4-setup" target="_blank" rel="noreferrer">GA4 setup guide<span className="sr-only"> (opens in new tab)</span></a>
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
