"use client";

import { useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Skeleton } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";
import { SectionBoundary } from "@/components/ui/SectionBoundary";
import { MacroSummaryCard } from "./MacroSummaryCard";
import { MacroEmptyState } from "./MacroEmptyState";
import type { UnitTradeSample } from "./UnitTradeSampleCard";
import dynamic from "next/dynamic";
import { MechanicsTrendCard } from "./MechanicsTrendCard";
import { useMacroBackfill } from "./useMacroBackfill";
import { FocusCard } from "./macro/report/FocusCard";
import { ScoreBucketsCard } from "./macro/report/ScoreBucketsCard";
import { SegmentsCard } from "./macro/report/SegmentsCard";
import { LeakLedgerCard } from "./macro/report/LeakLedgerCard";
import { ReportGamesModal } from "./macro/report/ReportGamesModal";
import { TargetsCard } from "./macro/targets/TargetsCard";
import type { MacroReportData, ReportDrill } from "./macro/report/types";

const UnitTradeSampleCard = dynamic(() => import("./UnitTradeSampleCard").then(module => module.UnitTradeSampleCard));

/**
 * Macro tab — the aggregate macro report.
 *
 * The per-game drill-down used to live here, but it duplicated the
 * macro-breakdown popover already reachable from every game row, so
 * this surface now answers the questions only an aggregate can:
 *
 *   - Header (MacroSummaryCard): average score, coverage, backfill.
 *   - Focus card: the single costliest leak and whether it's trending
 *     better or worse.
 *   - Score buckets: does better macro actually win you games?
 *   - Segments: where macro collapses (matchup / length / build).
 *   - Leak ledger: every leak priced in minerals with win-rate impact.
 *
 *   - Targets (first): your last 20 games against your league and the
 *     next one, timing gaps and a season goal estimate.
 *
 * Every clickable row opens ReportGamesModal — the exact games behind
 * the number, each expandable into the existing per-game breakdown.
 * One report request per filter change; no synthesised data anywhere.
 */
export function MacroTab() {
  const { filters, dbRev } = useFilters();
  const [tradeOpen, setTradeOpen] = useState(false);
  const [drill, setDrill] = useState<ReportDrill | null>(null);

  const report = useApi<MacroReportData>(
    `/v1/macro/report${filtersToQuery(filters)}#${dbRev}`,
  );
  const trade = useApi<UnitTradeSample>(tradeOpen ? `/v1/macro/unit-trades${filtersToQuery(filters)}#${dbRev}` : null);
  const backfill = useMacroBackfill(() => { void report.mutate(); });

  return (
    <div className="space-y-4">
      <SectionBoundary label="your league targets"><TargetsCard onDrill={setDrill} /></SectionBoundary>
      <MacroSummaryCard backfill={backfill} />
      <MechanicsTrendCard />
      <details onToggle={event => setTradeOpen(event.currentTarget.open)} className="rounded-lg border border-border bg-bg-surface p-4">
        <summary className="min-h-9 cursor-pointer text-body font-semibold">Unit trades by matchup</summary>
        {tradeOpen ? <QueryState q={trade} errorTitle="Unit trades" skeleton={<Skeleton rows={3} />}>{data =>
          <UnitTradeSampleCard sample={data} />
        }</QueryState> : null}
      </details>
      <QueryState
        q={report}
        skeleton={<Skeleton rows={6} />}
        errorTitle="Macro report"
        filtered
        isEmpty={(data) => !data || data.gamesScored === 0}
        empty={
          <MacroEmptyState backfill={backfill} />
        }
      >
        {(data) => (
          <>
            <FocusCard report={data} />
            <div className="grid gap-4 xl:grid-cols-2">
              <ScoreBucketsCard buckets={data.scoreBuckets} onDrill={setDrill} />
              <SegmentsCard report={data} onDrill={setDrill} />
            </div>
            <LeakLedgerCard
              leaks={data.leaks}
              gamesScored={data.gamesScored}
              onDrill={setDrill}
            />
          </>
        )}
      </QueryState>
      <ReportGamesModal drill={drill} onClose={() => setDrill(null)} />
    </div>
  );
}
