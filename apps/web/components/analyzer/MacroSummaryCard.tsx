"use client";

import { useEffect, useMemo } from "react";
import { Gauge, RefreshCcw } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { scoreToneTextClass } from "@/lib/macro";
import type { MacroBackfill } from "./useMacroBackfill";

type MacroSummaryResp = { gamesTotal: number; gamesWithMacro: number; gamesMissingMacro: number; avgScore: number | null };

/** Score, coverage and the shared backfill action. The priced leak list lives
 * once in LeakLedgerCard, with the highest-priority leak in FocusCard. */
export function MacroSummaryCard({ backfill }: { backfill: MacroBackfill }) {
  const { filters, dbRev } = useFilters();
  const query = useMemo(() => filtersToQuery(filters), [filters]);
  const { data, isLoading, mutate } = useApi<MacroSummaryResp>(`/v1/macro/summary${query}#${dbRev}`);
  useEffect(() => { if (backfill.job?.status === "done") void mutate(); }, [backfill.job?.status, mutate]);
  if (isLoading) return <Card><Skeleton rows={2} /></Card>;
  if (!data || data.gamesTotal === 0) return null;
  const coverage = Math.round(data.gamesWithMacro / data.gamesTotal * 100);
  return <Card><div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
    <div className="flex items-start gap-4"><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-2 border-line bg-bg-elevated"><Gauge className="h-6 w-6 text-accent-cyan" aria-hidden /></div>
      <div><div className="text-micro uppercase tracking-wider text-text-dim">Average macro score</div><div className={`text-3xl font-bold tabular-nums ${scoreToneTextClass(data.avgScore)}`}>{data.avgScore ?? "—"}</div><div className="mt-0.5 text-caption text-text-dim">{data.gamesWithMacro.toLocaleString()} of {data.gamesTotal.toLocaleString()} games scored ({coverage}%)</div></div>
    </div>
    {data.gamesMissingMacro > 0 || backfill.running ? <div className="space-y-1.5 lg:text-right">
      {backfill.running ? <Badge variant="cyan">Backfilling {backfill.job?.done ?? 0}/{backfill.job?.total ?? "…"}{backfill.job?.errors ? ` · ${backfill.job.errors} failed` : ""}</Badge>
        : <Button variant="secondary" onClick={backfill.start} disabled={backfill.starting} iconLeft={<RefreshCcw className="h-4 w-4" aria-hidden />}>Score {data.gamesMissingMacro.toLocaleString()} older {data.gamesMissingMacro === 1 ? "game" : "games"}</Button>}
      <p className="max-w-xs text-micro text-text-dim">{backfill.running ? "Your desktop app is re-parsing those replays and uploading scores." : "Needs your desktop app online and the original replays on your PC."}</p>
      {backfill.error ? <p className="text-micro text-danger" role="alert">{backfill.error}</p> : null}
    </div> : null}
  </div></Card>;
}
