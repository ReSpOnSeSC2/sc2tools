"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, BarChart3, ChartNoAxesCombined, Clock3, Crosshair, List, Repeat2, Timer, TrendingUp, Users } from "lucide-react";
import { Card, EmptyState } from "@/components/ui/Card";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useTrendsApi, useTrendsDataScope } from "@/lib/trendsDataContext";
import type { ExplorerControls, ExplorerResponse, ExplorerView } from "@/lib/trendsExplorer";
import { ExplorerPanelControls, initialExplorerControls } from "./ExplorerControls";
import { ExplorerVisualization, type ExplorerSegment } from "./ExplorerCharts";
import { ExplorerGamesModal } from "./ExplorerGamesModal";
import { CONTROL_CLASS, ExplorerError, ExplorerLoading, ExplorerStat, formatCount, formatRate } from "./ExplorerPrimitives";

const VIEWS = [
  { id: "mmr-gap", label: "MMR difference", icon: TrendingUp, title: "Performance by MMR difference", description: "See how results change against opponents rated below, near, or above the player at game time." },
  { id: "periods", label: "Compare periods", icon: ArrowLeftRight, title: "Compare two periods", description: "Measure what changed between two stretches of play, then look at the matchups and builds behind the difference." },
  { id: "groups", label: "Compare groups", icon: Users, title: "Compare player groups", description: "Put two sets of players or MMR ranges side by side, with control over how each player contributes." },
  { id: "execution", label: "Build execution", icon: Timer, title: "Build execution consistency", description: "Track when important milestones happen and how consistently they are reached across games." },
  { id: "leads", label: "Leads & comebacks", icon: Crosshair, title: "Lead conversion and comebacks", description: "Explore results from an advantage, an even position, or a deficit at a specific moment in the game." },
  { id: "breaks", label: "Breaks & results", icon: Clock3, title: "Break length and performance", description: "Compare results after immediate requeues and longer breaks, including specifically after wins or losses." },
  { id: "rematches", label: "Rematches", icon: Repeat2, title: "Rematch adaptation", description: "See whether results improve as a player encounters the same opponent again." },
] as const;

export function TrendsExplorer() {
  const [view, setView] = useState<ExplorerView>("mmr-gap");
  const [controls, setControls] = useState(initialExplorerControls);
  return <Card padded={false} className="min-w-0" aria-labelledby="trends-explorer-heading">
    <header className="border-b border-border px-4 py-4 sm:px-5"><div className="flex items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent/20 bg-accent/10 text-accent"><ChartNoAxesCombined aria-hidden className="h-5 w-5" /></span><div className="min-w-0"><h3 id="trends-explorer-heading" className="text-base font-semibold tracking-tight text-text">Explore performance</h3><p className="mt-1 text-xs leading-relaxed text-text-muted">Seven focused analyses. Choose a question and explore the games behind the result.</p></div></div></header>
    <nav aria-label="Performance analyses" className="border-b border-border bg-bg-elevated/40 p-3 sm:px-4">
      <label className="block sm:hidden"><span className="sr-only">Choose performance analysis</span><select className={CONTROL_CLASS} value={view} onChange={(event) => setView(event.target.value as ExplorerView)}>{VIEWS.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
      <div className="hidden flex-wrap gap-1.5 sm:flex">{VIEWS.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-pressed={view === id} onClick={() => setView(id)} className={`inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${view === id ? "border-accent/30 bg-bg-surface text-accent shadow-sm" : "border-transparent text-text-muted hover:border-border hover:bg-bg-surface"}`}><Icon aria-hidden className="h-3.5 w-3.5" />{label}</button>)}</div>
    </nav>
    <ExplorerPanel key={view} view={view} controls={controls[view]} setControls={(next) => setControls((current) => ({ ...current, [view]: next }))} />
  </Card>;
}

function ExplorerPanel({ view, controls, setControls }: { view: ExplorerView; controls: ExplorerControls; setControls: (next: ExplorerControls) => void }) {
  const { filters, dbRev } = useFilters();
  const { isGlobal, cohort } = useTrendsDataScope();
  const [display, setDisplay] = useState<"chart" | "table">("chart");
  const [segment, setSegment] = useState<ExplorerSegment | null>(null);
  const item = VIEWS.find((entry) => entry.id === view)!;
  // An unset local build control means inherit the page filter. It must not
  // erase the page's build with an undefined spread property.
  const query = useMemo(() => {
    const normalized = { ...controls };
    if (view === "groups" && controls.group_mode === "mmr") {
      for (const group of ["a", "b"]) {
        if (normalized[`${group}_min`] === "") normalized[`${group}_min`] = 0;
        if (normalized[`${group}_max`] === "") normalized[`${group}_max`] = 10001;
      }
    }
    return { ...filters, ...Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined && value !== "")) };
  }, [filters, controls, view]);
  const queryString = filtersToQuery(query);
  const { data, isLoading, error, mutate } = useTrendsApi<ExplorerResponse>(`/v1/trends/explorer/${view}${queryString}#${dbRev}`, { refreshInterval: (latest) => latest?.preparation?.pendingGames ? 15000 : 0 });
  // SWR can clear the prior error before isLoading flips during mutate().
  // An absent response is still pending, never an empty analysis result.
  const pending = isLoading || (!data && !error);
  const optionScope = JSON.stringify({ filters, isGlobal, cohort });
  const priorOptions = useRef<{ scope: string; options: ExplorerResponse["options"] } | null>(null);
  useEffect(() => {
    if (data?.options) priorOptions.current = { scope: optionScope, options: data.options };
  }, [data?.options, optionScope]);
  // Keep account choices visible during a comparison refresh. A new outer
  // filter or population scope invalidates this options-only fallback.
  const options = data?.options ?? (priorOptions.current?.scope === optionScope ? priorOptions.current.options : undefined);
  const identity = `${view}:${queryString}:${dbRev}:${JSON.stringify(cohort)}`;
  useEffect(() => { setSegment(null); }, [identity]);
  const currentRows = data?.rows ?? [];
  return <div className="min-w-0 space-y-5 p-4 sm:p-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><h4 className="text-sm font-semibold text-text">{item.title}</h4><p className="mt-1 max-w-3xl text-xs leading-relaxed text-text-muted">{item.description}</p></div><div className="inline-flex self-start rounded-lg border border-border bg-bg-elevated p-1" aria-label="Analysis display">{([{ id: "chart", label: "Chart", icon: BarChart3 }, { id: "table", label: "Data", icon: List }] as const).map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-pressed={display === id} onClick={() => setDisplay(id)} className={`inline-flex min-h-10 items-center gap-1.5 rounded-md px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${display === id ? "bg-bg-surface text-accent shadow-sm" : "text-text-muted"}`}><Icon aria-hidden className="h-3.5 w-3.5" />{label}</button>)}</div></div>
    <div className="rounded-xl border border-border bg-bg-elevated/30 p-3 sm:p-4"><ExplorerPanelControls view={view} values={controls} onChange={(next) => { setSegment(null); setControls(next); }} options={options} isGlobal={isGlobal} /></div>
    {!error && data?.preparation?.pendingGames ? <div role="status" className="rounded-lg border border-accent/20 bg-accent/5 px-3 py-2 text-xs leading-relaxed text-text-muted">Preparing measurements for {formatCount(data.preparation.pendingGames)} games. Available results appear below and update automatically.</div> : null}
    {!pending && !error && data && !currentRows.some((row) => row.games > 0) ? <div className="grid grid-cols-2 gap-3"><ExplorerStat label="Games analyzed" value={formatCount(data.eligibleGames)} detail={`Of ${formatCount(data.totalGames)} selected games`} /><ExplorerStat label="Data coverage" value={data.totalGames ? formatRate(data.eligibleGames / data.totalGames) : "—"} detail="Missing measurements stay excluded" /></div> : null}
    <div key={identity} aria-live="polite" aria-busy={pending}>
      {error ? <ExplorerError message={error.message} retry={mutate} /> : pending ? <ExplorerLoading title={item.title} /> : !data || !currentRows.some((row) => row.games > 0) ? <EmptyState title="No eligible games for this analysis" sub={view === "execution" || view === "leads" ? "This analysis needs detailed replay measurements. Try another milestone, checkpoint, or filter selection. Missing measurements are never replaced with estimates." : view === "periods" ? "Try periods that contain games, or adjust the other page filters." : "Adjust the page filters or analysis settings to include more games."} /> : <ExplorerVisualization view={view} data={data} display={display} onSelect={setSegment} weighted={view === "groups" && controls.weight === "players"} />}
    </div>
    {!pending && !error && data?.notes?.length ? <details className="rounded-lg border border-border bg-bg-elevated/30 px-3 py-2"><summary className="min-h-8 cursor-pointer py-1 text-[11px] font-medium text-text-muted">Coverage and how to read this analysis</summary><ul className="space-y-1.5 pb-1 pl-4 pt-2 text-[11px] leading-relaxed text-text-dim">{data.notes.map((note, index) => <li key={index} className="list-disc">{note}</li>)}</ul></details> : null}
    {segment ? <ExplorerGamesModal key={`${identity}:${segment.key}`} view={view} query={query} dbRev={dbRev} segment={segment} onClose={() => setSegment(null)} /> : null}
  </div>;
}
