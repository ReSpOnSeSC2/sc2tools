"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import useSWR from "swr";
import { fetchSiteStats } from "@/lib/siteStats";

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const COMPACT_NUMBER_FORMAT = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });
const REFRESH_MS = 30_000;
const STALE_MS = 90_000;

async function fetchActivity(url: string) {
  return { ...await fetchSiteStats(url), receivedAt: Date.now() };
}

/** Public aggregates, shared by the marketing site and the app shell. */
export function SiteStats({ wide = false, syncStatus }: {
  wide?: boolean;
  syncStatus?: ReactNode;
}) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { data, error, isLoading } = useSWR("/api/site/stats", fetchActivity, {
    refreshInterval: REFRESH_MS,
    dedupingInterval: 10_000,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    errorRetryInterval: REFRESH_MS,
    keepPreviousData: true,
  });

  // A browser that loses its connection must not keep labelling an old
  // snapshot as current merely because SWR retained the last good response.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  // Measure freshness on this browser's clock, avoiding skew with the API.
  const stale = Boolean(data && now - data.receivedAt > STALE_MS);
  const unavailable = Boolean(error) || stale;
  const values = [
    { label: "Agent downloads", compactLabel: "Downloads", value: data?.agentDownloads },
    { label: "Active agents", compactLabel: "Agents", value: data?.activeAgents },
    { label: "Users online", compactLabel: "Online", value: data?.activeUsers },
  ];
  const partial = values.some(({ value }) => value == null);
  const status = isLoading && !data
    ? "Loading activity"
    : unavailable
      ? "Updates unavailable"
      : partial
        ? "Some counts unavailable"
        : "Updates every 30 seconds";

  return (
    <section aria-label="SC2 Tools community activity" className="border-b border-border bg-bg-surface/40">
      <div className={`mx-auto w-full px-4 sm:px-6 lg:px-8 ${wide ? "max-w-[1680px]" : "max-w-7xl"}`}>
        <div
          role="group"
          aria-label="Game sync and site activity"
          className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 text-caption text-text-muted xl:flex xl:gap-5"
        >
          {syncStatus ? <div className="min-w-0">{syncStatus}</div> : <p className="xl:hidden">Site activity</p>}
          <dl className="col-span-2 row-start-2 flex items-center justify-between divide-x divide-border xl:shrink-0 xl:justify-start">
            {values.map(({ label, compactLabel, value }, index) => (
              <div key={label} className={`flex items-baseline gap-1 whitespace-nowrap pr-2 last:pr-0 xl:gap-1.5 xl:pr-5 ${index ? "pl-2 xl:pl-5" : ""}`}>
                <dt className="order-2 text-caption font-normal text-text-muted">
                  <span aria-hidden className="sm:hidden">{compactLabel}</span>
                  <span className="sr-only sm:not-sr-only">{label}</span>
                </dt>
                <dd className="order-1 font-mono text-caption font-normal tabular-nums text-text">
                  {isLoading && !data ? (
                    <span aria-label="Loading" className="inline-block h-3 w-6 rounded bg-bg-subtle motion-safe:animate-pulse" />
                  ) : value == null || unavailable ? (
                    <span aria-label="Unavailable" className="text-text-dim">—</span>
                  ) : value >= 1_000 ? (
                    <span title={NUMBER_FORMAT.format(value)}>
                      <span aria-hidden className={value >= 100_000 ? "2xl:hidden" : "sm:hidden"}>{COMPACT_NUMBER_FORMAT.format(value)}</span>
                      <span className={value >= 100_000 ? "sr-only 2xl:not-sr-only" : "sr-only sm:not-sr-only"}>{NUMBER_FORMAT.format(value)}</span>
                    </span>
                  ) : NUMBER_FORMAT.format(value)}
                </dd>
              </div>
            ))}
          </dl>
          <button
            type="button"
            aria-label="About these activity counts"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((open) => !open)}
            className="col-start-2 row-start-1 ml-auto flex h-5 min-w-8 shrink-0 items-center justify-center gap-2 rounded-md px-1 text-caption font-normal text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent xl:h-8 xl:px-2"
          >
            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${!isLoading && !unavailable && !partial ? "bg-success" : "bg-text-dim"}`} />
            <span className="hidden xl:inline">Site activity</span>
            <ChevronDown aria-hidden className={`h-3.5 w-3.5 ${expanded ? "rotate-180" : ""}`} />
          </button>
        </div>
        <div id={detailsId} hidden={!expanded} className="border-t border-border py-4 text-caption text-text-muted">
          <p className="mb-3 font-medium text-text">{status}</p>
          <dl className="grid gap-3 sm:grid-cols-3 sm:gap-6">
            <div><dt className="font-semibold text-text">Agent downloads</dt><dd>Installer downloads started through this website since tracking began. Repeat downloads count; completed installations are not measured.</dd></div>
            <div><dt className="font-semibold text-text">Active agents</dt><dd>Paired desktop agents that checked in within the last {Math.round((data?.activityWindowSeconds ?? 180) / 60)} minutes. Revoked agents are excluded.</dd></div>
            <div><dt className="font-semibold text-text">Users online</dt><dd>Visitors whose browsers checked in within the last {Math.round((data?.activityWindowSeconds ?? 180) / 60)} minutes. Check-ins pause on hidden or idle pages. Signed-in users count once across devices; signed-out visitors count once per browser. Broadcast overlays are excluded.</dd></div>
          </dl>
          <p className="mt-3">Counts refresh automatically. A dash means the count is unavailable.</p>
        </div>
        <span role="status" className="sr-only">{status}</span>
      </div>
    </section>
  );
}
