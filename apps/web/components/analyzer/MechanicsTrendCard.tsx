"use client";

import { useMemo, useState } from "react";
import { Card, Skeleton } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { useApi } from "@/lib/clientApi";
import { filtersToQuery, useFilters } from "@/lib/filterContext";
import { apiToPeriods, clientTimezone, type ApiTimeseriesResponse } from "@/lib/timeseries";
import { isMechanicsBucket, MECHANICS_METRICS, type MechanicsBucket, type MechanicsMetric } from "@/lib/mechanicsTrend";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import { useBenchmarks } from "@/lib/useBenchmarks";
import { BENCHMARK_MIN_SAMPLE, percentileOf } from "@/lib/benchmarks";
import { MacroTrendChart } from "./charts/MacroTrendChart";

const LEAGUES = ["Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master", "Grandmaster"];
const BENCHMARK_KEY = { macro: "macroScore", apm: "apm", sq: "spq" } as const;
const RACE_LETTER: Record<string, string> = { P: "P", Protoss: "P", T: "T", Terran: "T", Z: "Z", Zerg: "Z" };

export function MechanicsTrendCard() {
  const { filters, dbRev } = useFilters();
  const [metric, setMetric] = useState<MechanicsMetric>("macro");
  const [bucket, setBucket] = useLocalStorageState<MechanicsBucket>("analyzer.trends.bucket", "week", isMechanicsBucket);
  const [league, setLeague] = useState<string>("");
  const tz = useMemo(() => clientTimezone(), []);
  const q = useApi<ApiTimeseriesResponse>(`/v1/timeseries${filtersToQuery({ ...filters, interval: bucket, tz })}#${dbRev}`);
  const left = RACE_LETTER[filters.race ?? ""], right = RACE_LETTER[filters.opp_race ?? ""], matchup = left && right ? `${left}v${right}` : null;
  const comparable = !!matchup && filters.game_size === "1v1" && filters.map_pool === "ladder";
  const benchmark = useBenchmarks(league === "" || !comparable ? null : Number(league), comparable ? matchup : null);
  const table = benchmark.data?.table, sample = table?.metrics[BENCHMARK_KEY[metric]];
  const median = sample?.deciles?.[4];
  const reference = comparable && league !== "" && !q.isPreviousData && !benchmark.error && !benchmark.isPreviousData && table?.leagueId === Number(league) && table.matchup === matchup && sample && sample.n >= BENCHMARK_MIN_SAMPLE && typeof median === "number" && median >= 0 && (metric !== "macro" || median <= 100) && percentileOf(sample, median)
    ? { value: median, label: `${table.league} opponent bracket · ${table.matchup} median · n=${sample.n}` } : null;
  return <Card title="Mechanics progress" headingLevel={2} data-testid="mechanics-trend-card" right={<LazyHelpLink slug="macro" anchor="progress">Help</LazyHelpLink>}>
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div role="group" aria-label="Mechanics metric" className="flex flex-wrap gap-1">{(Object.keys(MECHANICS_METRICS) as MechanicsMetric[]).map(key => <button key={key} type="button" aria-pressed={metric === key} onClick={() => setMetric(key)} className={`min-h-11 rounded-md border px-3 text-caption ${metric === key ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted"}`}>{MECHANICS_METRICS[key].label}</button>)}</div>
        <label className="flex items-center gap-2 text-micro text-text-muted">Group by<select aria-label="Mechanics period" value={bucket} onChange={event => setBucket(event.target.value as MechanicsBucket)} className="min-h-11 rounded-md border border-border bg-bg-surface px-2 text-caption text-text"><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></select></label>
      </div>
      <p className="text-caption text-text-muted">{MECHANICS_METRICS[metric].description}</p>
      <label className="flex flex-wrap items-center gap-2 text-micro text-text-muted">Opponent league reference<select aria-label="Opponent league reference" value={league} disabled={!comparable} onChange={event => setLeague(event.target.value)} className="min-h-11 max-w-full rounded-md border border-border bg-bg-surface px-2 text-caption text-text disabled:opacity-50"><option value="">Off</option>{LEAGUES.map((name, index) => <option key={name} value={index}>{name}</option>)}</select>{!comparable ? <span>Choose ranked 1v1, one own race and one opponent race in the filters to compare a matchup.</span> : null}</label>
      {league && comparable && !reference ? <p className="text-micro text-text-muted">{benchmark.isLoading ? "Loading league reference…" : "No measured league median available for this metric and matchup. Your trend remains available."}</p> : null}
      <QueryState q={q} skeleton={<Skeleton rows={5} />} errorTitle="Mechanics progress" filtered>{(data, state) => <div aria-busy={state.isPreviousData} className={state.isPreviousData ? "opacity-60" : undefined}>{state.isPreviousData ? <p className="mb-2 text-micro text-text-muted">Updating the selected filters; showing the previous periods.</p> : null}<MacroTrendChart series={apiToPeriods(data, tz)} metric={metric} bucket={data.interval ?? bucket} reference={reference} /></div>}</QueryState>
    </div>
  </Card>;
}
