"use client";

import { useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { MacroSummaryCard } from "./MacroSummaryCard";
import { FocusCard } from "./macro/report/FocusCard";
import { ScoreBucketsCard } from "./macro/report/ScoreBucketsCard";
import { SegmentsCard } from "./macro/report/SegmentsCard";
import { LeakLedgerCard } from "./macro/report/LeakLedgerCard";
import { ReportGamesModal } from "./macro/report/ReportGamesModal";
import type { MacroReportData, ReportDrill } from "./macro/report/types";

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
 * Every clickable row opens ReportGamesModal — the exact games behind
 * the number, each expandable into the existing per-game breakdown.
 * One report request per filter change; no synthesised data anywhere.
 */
export function MacroTab() {
  const { filters, dbRev } = useFilters();
  const [drill, setDrill] = useState<ReportDrill | null>(null);

  const { data, error, isLoading } = useApi<MacroReportData>(
    `/v1/macro/report${filtersToQuery(filters)}#${dbRev}`,
  );

  return (
    <div className="space-y-4">
      <MacroSummaryCard />
      {isLoading ? (
        <Skeleton rows={6} />
      ) : error ? (
        <Card>
          <p className="text-sm text-danger">{error.message}</p>
        </Card>
      ) : !data || data.gamesScored === 0 ? (
        <Card>
          <EmptyState
            title="No scored games yet"
            sub="Macro scores arrive with agent uploads — or use the backfill above to score older replays."
          />
        </Card>
      ) : (
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
      <ReportGamesModal drill={drill} onClose={() => setDrill(null)} />
    </div>
  );
}
