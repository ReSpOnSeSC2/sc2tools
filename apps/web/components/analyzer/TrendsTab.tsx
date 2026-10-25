"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import type { ReactNode } from "react";
import { useTrendsApi as useApi, useTrendsDataScope } from "@/lib/trendsDataContext";
import { TrendsRequestError } from "./charts/TrendsRequestError";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { pct1, wrColor } from "@/lib/format";
import { Card, EmptyState, Skeleton, Stat } from "@/components/ui/Card";
import {
  apiToPeriods,
  clientTimezone,
  type ApiTimeseriesResponse,
  type Period,
} from "@/lib/timeseries";
import { FingerprintCard } from "./FingerprintCard";
import { MatchupOverTimeChart } from "./charts/MatchupOverTimeChart";
import { MatchupRatingCard } from "./charts/MatchupRatingCard";
import { MatchupGameLengthCard } from "./charts/MatchupGameLengthCard";
import { TimeOfDayHeatmap } from "./charts/TimeOfDayHeatmap";
import { GameLengthWrChart } from "./charts/GameLengthWrChart";
import { ActivityCalendarChart } from "./charts/ActivityCalendarChart";
import { MmrProgressionChart } from "./charts/MmrProgressionChart";
import { MomentumChart } from "./charts/MomentumChart";
import { OppMmrBucketsChart } from "./charts/OppMmrBucketsChart";
import { MapTrendChart } from "./charts/MapTrendChart";
import { NetMmrByMatchupChart } from "./charts/NetMmrByMatchupChart";
import { ActivityVolumeChart } from "./charts/ActivityVolumeChart";
import { WinRateTrendCard } from "./charts/WinRateTrendCard";
import { DeferredTrendsExplorer } from "./explorer/DeferredTrendsExplorer";

const LS_BUCKET = "analyzer.trends.bucket";
type Bucket = "day" | "week" | "month";
const GROUPS = [
  ["overview", "Overview"], ["performance", "Performance & MMR"],
  ["time", "Time & activity"], ["explorer", "Explorer"], ["fingerprint", "Fingerprint"],
] as const;
type Group = typeof GROUPS[number][0];
const isBucket = (value: unknown): value is Bucket => value === "day" || value === "week" || value === "month";
const isCollapsed = (value: unknown): value is Partial<Record<Group, boolean>> => Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === "boolean"));

export function TrendsTab() {
  const rootRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const update = () => rootRef.current?.style.setProperty("--trends-nav-height", `${navRef.current?.getBoundingClientRect().height || 144}px`);
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (navRef.current) observer?.observe(navRef.current);
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); };
  }, []);
  const { isGlobal } = useTrendsDataScope();
  const { filters, dbRev } = useFilters();
  const [bucket, setBucket] = useLocalStorageState<Bucket>(LS_BUCKET, "week", isBucket);
  const [collapsed, setCollapsed] = useLocalStorageState<Partial<Record<Group, boolean>>>("analyzer.trends.collapsed", {}, isCollapsed);
  const [activeGroup, setActiveGroup] = useState<Group>("overview");
  const [pendingJump, setPendingJump] = useState<Group | null>(null);
  useEffect(() => {
    if (!pendingJump) return;
    const heading = document.getElementById(`trends-${pendingJump}-heading`);
    heading?.scrollIntoView({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    heading?.focus({ preventScroll: true });
    setPendingJump(null);
  }, [pendingJump]);
  const jump = (group: Group) => {
    setCollapsed({ ...collapsed, [group]: false });
    setActiveGroup(group);
    setPendingJump(group);
  };
  const groupProps = (id: Group) => ({ id, collapsed: Boolean(collapsed[id]), toggle: () => setCollapsed({ ...collapsed, [id]: !collapsed[id] }) });

  const tz = useMemo(() => clientTimezone(), []);
  const params = useMemo(
    () => ({ ...filters, interval: bucket, tz }),
    [filters, bucket, tz],
  );
  const { data, isLoading, error, mutate } = useApi<ApiTimeseriesResponse>(
    `/v1/timeseries${filtersToQuery(params)}#${dbRev}`,
  );
  const series: Period[] = useMemo(
    () => apiToPeriods(data, tz),
    [data, tz],
  );
  const effectiveBucket = data?.interval ?? bucket;

  const kpis = useMemo(() => {
    const totalGames = series.reduce((a, p) => a + (p.games || 0), 0);
    const totalWins = series.reduce((a, p) => a + (p.wins || 0), 0);
    const totalLoss = series.reduce((a, p) => a + (p.losses || 0), 0);
    const wr = totalGames ? totalWins / totalGames : 0;
    return {
      totalGames,
      totalWins,
      totalLoss,
      wr,
      activePeriods: series.filter((period) => period.games > 0).length,
    };
  }, [series]);

  return (
    <div ref={rootRef} className="space-y-4">
      <div ref={navRef} className="sticky top-[calc(3rem+env(safe-area-inset-top))] z-20 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-bg-surface px-3 py-2 shadow-sm">
        <nav aria-label="Trend sections" className="flex min-w-0 flex-1 basis-full gap-1 overflow-x-auto sm:basis-0">
          {GROUPS.filter(([id]) => !isGlobal || id !== "fingerprint").map(([id, label]) => <button key={id} type="button" onClick={() => jump(id)} aria-current={activeGroup === id ? "location" : undefined} className={`min-h-11 shrink-0 rounded-full px-3 text-caption ${activeGroup === id ? "bg-accent/10 text-accent" : "text-text-muted hover:bg-bg-elevated"}`}>{label}</button>)}
        </nav>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <label htmlFor="trends-period" className="text-xs text-text-muted">Group charts by</label>
          <select
            id="trends-period"
            value={bucket}
            onChange={(e) => setBucket(e.target.value as Bucket)}
            aria-describedby="trends-grouping-hint"
            className="rounded-lg border-2 border-line bg-bg-surface px-3 py-[0.55rem] text-text transition-colors focus:border-accent focus:outline-none text-sm"
          >
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
          <p id="trends-grouping-hint" className="basis-full text-micro text-text-muted">Applies to activity, matchup, MMR and map charts</p>
        </div>
      </div>

      <TrendsGroup {...groupProps("overview")} title="Overview">
      {isLoading ? <div role="status" aria-label="Loading summary" className="grid min-h-28 grid-cols-2 gap-3 md:grid-cols-4">{[0, 1, 2, 3].map((key) => <Card key={key}><Skeleton rows={2} /></Card>)}</div> : error ? <div className="min-h-28"><TrendsRequestError title="Summary" error={error} retry={mutate} /></div> : <div className="grid min-h-28 grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label={isGlobal ? "Player game records" : "Games"}
          value={kpis.totalGames}
        />
        <Stat
          label="Overall WR"
          value={kpis.totalGames > 0 ? pct1(kpis.wr) : "—"}
          color={wrColor(kpis.wr, kpis.totalGames)}
        />
        <Stat label="Recorded results" value={`${kpis.totalWins.toLocaleString()}W · ${kpis.totalLoss.toLocaleString()}L`} />
        <Stat label={`Active ${effectiveBucket}s`} value={kpis.activePeriods} />
      </div>}

      {isGlobal && !isLoading && !error && effectiveBucket !== bucket && (
        <p role="status" className="rounded-lg border border-border bg-bg-surface px-3 py-2 text-caption text-text-muted">
          Showing {effectiveBucket === "month" ? "monthly" : effectiveBucket === "week" ? "weekly" : "daily"} periods to cover this date range. Choose a shorter range for finer detail.
        </p>
      )}

      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
          {isLoading || error || series.length === 0 ? (
            ["Games played"].map((title) => error ? (
              <TrendsRequestError key={title} title={title} error={error} retry={mutate} />
            ) : (
              <Card key={title} title={title}>
                {isLoading ? <div role="status" aria-label={`Loading ${title}`}><Skeleton rows={4} /></div>
                  : <EmptyState
                      title={isGlobal ? "No player game records match these filters" : "No games match these filters"}
                      sub={isGlobal ? "Adjust the player selection or game filters to broaden this view." : "Adjust the game filters or upload more games to broaden this view."}
                    />}
              </Card>
            ))
          ) : <ActivityVolumeChart periods={series} interval={effectiveBucket} isGlobal={isGlobal} />}
          <WinRateTrendCard />
          {/* Matchup win rates read as a breakdown of the headline win rate. */}
          <div className="md:col-span-2">
            <MatchupOverTimeChart bucket={bucket as "day" | "week" | "month"} />
            <MatchupRatingCard />
          </div>
      </div>
      </TrendsGroup>

      <TrendsGroup {...groupProps("performance")} title="Performance & MMR" subtitle="Rating progress, matchup gains, opponent strength, and recent form.">
        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <MmrProgressionChart bucket={bucket as "day" | "week" | "month"} />
          </div>
          <NetMmrByMatchupChart />
          <OppMmrBucketsChart />
          <div className="md:col-span-2">
            <MomentumChart />
          </div>
        </div>
      </TrendsGroup>

      <TrendsGroup {...groupProps("time")} title="Time & activity" subtitle={isGlobal ? "When players play, how long games run, and how activity changes over time." : "When you play, how long games run, and how activity changes over time."}>
        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <MatchupGameLengthCard />
          </div>
          <TimeOfDayHeatmap />
          <GameLengthWrChart />
          <div className="md:col-span-2">
            <ActivityCalendarChart />
          </div>
          <div className="md:col-span-2">
            <MapTrendChart bucket={bucket as "day" | "week" | "month"} />
          </div>
      </div>
      </TrendsGroup>

      <TrendsGroup {...groupProps("explorer")} title="Explorer"><DeferredTrendsExplorer /></TrendsGroup>

      {/* The identity artifact closes the personal tab after the explorer. */}
      {!isGlobal && <TrendsGroup {...groupProps("fingerprint")} title="Fingerprint"><FingerprintCard /></TrendsGroup>}
    </div>
  );
}

/**
 * Subtle break between related chart groups. Spans both grid columns on
 * desktop and reflows on mobile.
 */
function TrendsGroup({
  id,
  title,
  subtitle,
  collapsed,
  toggle,
  children,
}: {
  id: Group;
  title: string;
  subtitle?: string;
  collapsed: boolean;
  toggle: () => void;
  children: ReactNode;
}) {
  return (
    <section id={`trends-${id}`} aria-labelledby={`trends-${id}-heading`} className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3 border-t border-border pt-4">
        <h2 id={`trends-${id}-heading`} tabIndex={-1} style={{ scrollMarginTop: "calc(3rem + env(safe-area-inset-top) + var(--trends-nav-height, 9rem) + 1rem)" }} className="text-sm font-semibold uppercase tracking-wider text-text">
          <button type="button" aria-expanded={!collapsed} aria-controls={`trends-${id}-content`} onClick={toggle} className="inline-flex min-h-11 items-center gap-2">{collapsed ? <ChevronRight aria-hidden className="h-4 w-4" /> : <ChevronDown aria-hidden className="h-4 w-4" />}{title}</button>
        </h2>
        {subtitle ? (
          <span className="text-caption text-text-dim">{subtitle}</span>
        ) : null}
      </div>
      <div id={`trends-${id}-content`} hidden={collapsed}>{collapsed ? null : children}</div>
    </section>
  );
}
