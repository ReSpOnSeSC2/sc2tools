"use client";

import { useId, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import type { PublicReplayDetailResponse } from "@/components/analyzer/replays/types";
import { fmtMinutes } from "@/lib/format";

const mineralsFormatter = new Intl.NumberFormat("en-US");

export function PublicMacroLeakCard({ data, onSeek }: { data: PublicReplayDetailResponse["macroBreakdown"]; onSeek?: (time: number) => void }) {
  const [expanded, setExpanded] = useState(false); const id = useId();
  const leaks = [...(data?.all_leaks?.length ? data.all_leaks : data?.top_3_leaks || [])].slice(0, 50).sort((a, b) => (b.penalty || 0) - (a.penalty || 0));
  const shown = expanded ? leaks : leaks.slice(0, 3);
  const hasCosts = leaks.some((leak) => typeof leak.mineral_cost === "number" && Number.isFinite(leak.mineral_cost));
  const minerals = leaks.reduce((sum, leak) => sum + (typeof leak.mineral_cost === "number" && Number.isFinite(leak.mineral_cost) ? Math.max(0, leak.mineral_cost) : 0), 0);
  function seek(time: number) {
    onSeek?.(time);
    document.getElementById("replay-analysis")?.scrollIntoView({ block: "start", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  return <Card title="Highest-impact macro leaks">
    {!leaks.length ? <EmptyStatePanel size="sm" title="No scored macro leaks" description="This replay has no detailed leak events in its uploaded analysis." /> : <div className="space-y-3">
      <ol id={id} className="space-y-3">{shown.map((leak, index) => <li key={`${leak.name || "leak"}-${index}`} className="rounded-lg border border-border bg-bg-elevated/45 p-3">
        <div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-text">{leak.name || "Macro inefficiency"}</p>{leak.detail ? <p className="mt-1 text-caption text-text-muted">{leak.detail}</p> : null}</div>{leak.penalty != null ? <Badge variant="danger" size="sm">−{Math.abs(Math.round(leak.penalty))} pts</Badge> : null}</div>
        {typeof leak.time === "number" && Number.isFinite(leak.time) && leak.time >= 0 ? onSeek ? <button type="button" onClick={() => seek(leak.time!)} aria-label={`Jump timeline to ${fmtMinutes(Math.round(leak.time))}`} className="mt-1 inline-flex min-h-11 items-center rounded-md px-1 font-mono text-caption font-semibold tabular-nums text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{fmtMinutes(Math.round(leak.time))}</button> : <p className="mt-2 font-mono text-caption tabular-nums text-text-muted">{fmtMinutes(Math.round(leak.time))}</p> : null}
        {leak.mineral_cost != null ? <p className="mt-2 font-mono text-micro tabular-nums text-warning">≈ {mineralsFormatter.format(Math.round(leak.mineral_cost))} minerals</p> : null}
      </li>)}</ol>
      {leaks.length > 3 ? <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((value) => !value)} className="inline-flex min-h-11 items-center rounded-md px-1 text-caption font-semibold text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{expanded ? "Show fewer leaks" : `Show all ${leaks.length} leaks`}</button> : null}
      {hasCosts ? <p className="text-caption text-text-muted">≈ {mineralsFormatter.format(Math.round(minerals))} minerals lost across {leaks.length} {leaks.length === 1 ? "leak" : "leaks"}</p> : null}
    </div>}
  </Card>;
}
