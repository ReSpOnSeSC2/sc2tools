"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { pct } from "@/lib/format";
import { timingDisplay, visibleDossierTimings, type VisibleTiming } from "@/lib/dossierTimings";
import type { DossierAnalysis, DossierTimingSource, TimingHistoryFilter } from "@/lib/dossierTypes";

const position = (value: number) => Math.max(0, Math.min(100, value / 6));
function TimingRange({ item }: { item: VisibleTiming }) {
  const { row, median } = item, from = row.p25Seconds, until = row.p75Seconds;
  const available = typeof from === "number" && Number.isFinite(from) && typeof until === "number" && Number.isFinite(until) && from >= 0 && until >= from;
  return <div className="space-y-1">
    <div role="img" aria-label={available ? `Middle half ${timingDisplay(from, row.p25Display)} to ${timingDisplay(until, row.p75Display)}; median ${timingDisplay(median, row.medianDisplay)}${median > 600 || until > 600 ? "; values beyond the axis shown at 10:00+" : ""}` : "Middle-half timing unavailable"} className="relative mx-1 h-2 rounded-full bg-bg-elevated">
      {available ? <span className="absolute inset-y-0 rounded-full bg-accent/40" style={{ left: `${position(from)}%`, width: `${position(until) - position(from)}%` }} /> : null}
      <span className="absolute top-1/2 h-3 w-1 -translate-x-1/2 -translate-y-1/2 rounded bg-accent" style={{ left: `${position(median)}%` }} />
    </div><div className="flex justify-between text-micro text-text-dim"><span>0:00</span><span>10:00+</span></div>
  </div>;
}

function TimingButton({ item, active, onSelect }: { item: VisibleTiming; active: boolean; onSelect?: (selection: TimingHistoryFilter | null) => void }) {
  const { row, median, n, selection } = item;
  const trend = row.trend === "earlier" ? "↘ getting earlier" : row.trend === "later" ? "↗ getting later" : row.trend === "stable" ? "→ stable" : "Trend unavailable";
  return <li><button type="button" aria-pressed={active} disabled={!selection || !onSelect} onClick={() => onSelect?.(active ? null : selection)} className={`block w-full space-y-2 rounded-lg border p-3 text-left disabled:cursor-default ${active ? "border-accent bg-accent/10" : "border-border"} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}>
    <span className="flex flex-wrap items-center justify-between gap-2"><span className="flex min-w-0 items-center gap-2"><Icon name={item.token} size="md" decorative /><strong className="break-words text-caption">{row.displayName || item.token}</strong></span><span className="font-mono text-caption tabular-nums">{timingDisplay(median, row.medianDisplay)} · n={n}</span></span>
    <TimingRange item={item} />
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-micro text-text-muted"><span>Last seen {timingDisplay(row.lastSeenSeconds, row.lastSeenDisplay)}</span><span>{trend}</span><span>Your win rate when built: {typeof row.winRateWhenBuilt === "number" && Number.isFinite(row.winRateWhenBuilt) && row.winRateWhenBuilt >= 0 && row.winRateWhenBuilt <= 1 ? `${pct(row.winRateWhenBuilt)} (n=${n})` : "Unavailable"}</span></span>
    <span className="block text-micro text-text-dim">{selection ? `${selection.gameIds.length} analyzed sample games${onSelect ? " · filter history" : ""}` : "Analyzed replay links unavailable"}</span>
  </button></li>;
}

export function OpponentKeyTimings({ analysis, selected, onSelect }: { analysis: DossierAnalysis; selected?: TimingHistoryFilter | null; onSelect?: (selection: TimingHistoryFilter | null) => void }) {
  const [chosenMatchup, setMatchup] = useState(""), [source, setSource] = useState<DossierTimingSource>("opp_build_log");
  const matchups = [...new Set([...Object.keys(analysis.matchupTimings ?? {}), ...Object.keys(analysis.matchupTimingsLegacy ?? {})])];
  const matchup = matchups.includes(chosenMatchup) ? chosenMatchup : "", rows = visibleDossierTimings(analysis, matchup, source);
  const available = source === "build_log" ? analysis.yourBuildOrdersAvailable : analysis.buildOrdersAvailable;
  return <Card title="Key timings" headingLevel={3}>
    <div className="mb-4 space-y-3"><div role="group" aria-label="Timing matchup" className="flex flex-wrap gap-1">{["", ...matchups].map(value => <button type="button" key={value} aria-pressed={matchup === value} onClick={() => setMatchup(value)} className={`min-h-11 rounded-md border px-3 text-caption ${matchup === value ? "border-accent text-accent" : "border-border text-text-muted"}`}>{value || "All matchups"}</button>)}</div>
      <div role="group" aria-label="Timing perspective" className="flex gap-1">{(["opp_build_log", "build_log"] as const).map(value => <button type="button" key={value} aria-pressed={source === value} onClick={() => setSource(value)} className={`min-h-11 rounded-md border px-3 text-caption ${source === value ? "border-accent text-accent" : "border-border text-text-muted"}`}>{value === "opp_build_log" ? "Theirs" : "Yours"}</button>)}</div>
      {available !== undefined && analysis.buildOrdersTotal !== undefined && available < analysis.buildOrdersTotal ? <p className="text-caption text-text-muted">Needs build orders: {available} of {analysis.buildOrdersTotal} games have one.</p> : null}
      <p className="text-micro text-text-dim">Analyzed sample{analysis.analysisSampleSize !== undefined ? `: ${analysis.analysisSampleSize} games` : ""}{analysis.analysisSampleTruncated ? ` (up to ${analysis.analysisSampleLimit ?? 100})` : ""}. Rows need at least two observations. Selecting one searches only its recorded sample games.</p>
    </div>
    {rows.length ? <ul className="space-y-3" aria-label="Recorded key timings">{rows.map(item => <TimingButton key={item.token} item={item} active={selected?.token === item.token && selected.source === source && (selected.matchup ?? "") === matchup} onSelect={onSelect} />)}</ul> : <p className="text-caption text-text-muted">Not enough recorded timings for this perspective and matchup.</p>}
  </Card>;
}
