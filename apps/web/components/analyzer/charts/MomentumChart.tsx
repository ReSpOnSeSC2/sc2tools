"use client";

import { useTrendsApi as useApi, useTrendsDataScope } from "@/lib/trendsDataContext";
import { TrendsRequestError } from "./TrendsRequestError";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { WinRateComparison } from "./WinRateComparison";

type MomentumSplit = { wins: number; losses: number; total: number; winRate: number };
type SessionPos = MomentumSplit & { pos: number };
type MomentumResponse = {
  sessionGapMinutes: number;
  baseline: MomentumSplit;
  postWin: MomentumSplit;
  postLoss: MomentumSplit;
  sessionPositions: SessionPos[];
};

export function MomentumChart() {
  const { isGlobal } = useTrendsDataScope();
  const { filters, dbRev } = useFilters();
  const { data, isLoading, error, mutate } = useApi<MomentumResponse>(`/v1/momentum${filtersToQuery(filters)}#${dbRev}`);

  if (error) return <TrendsRequestError title="Session patterns" error={error} retry={mutate} />;
  if (isLoading) return <Card title="Session patterns"><Skeleton rows={3} /></Card>;
  if (!data || data.baseline.total === 0) return (
    <Card title="Session patterns">
      <EmptyState title="Not enough games yet" sub={isGlobal ? "The selected players need recorded wins and losses to compare session patterns." : "Recorded wins and losses will show how results vary through a session."} />
    </Card>
  );

  const recordLabel = isGlobal ? "player game records" : "games";
  const afterRows = [
    { ...data.postWin, key: "win", label: "After a win", games: data.postWin.total, rate: data.postWin.total ? data.postWin.winRate : null },
    { ...data.postLoss, key: "loss", label: "After a loss", games: data.postLoss.total, rate: data.postLoss.total ? data.postLoss.winRate : null },
  ];
  const positions = [...data.sessionPositions].sort((a, b) => a.pos - b.pos).map((row) => ({
    ...row, key: String(row.pos), label: `Game ${row.pos}`, games: row.total, rate: row.total ? row.winRate : null,
  }));
  const initialPositions = positions.filter((row) => row.pos <= 6);
  const laterPositions = positions.filter((row) => row.pos > 6);

  return (
    <Card title="Session patterns">
      <p className="-mt-1 mb-3 text-caption leading-relaxed text-text-muted">
        {isGlobal ? "Sessions are measured separately for each player account and ladder race, then combined. " : ""}
        Sessions split on a {data.sessionGapMinutes}-min gap · {isGlobal ? "the cohort's" : "your"} overall win rate is {Math.round(data.baseline.winRate * 100)}%.
      </p>
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="min-w-0 rounded-lg border border-border bg-bg-elevated/30 p-3">
          <h4 className="mb-3 text-caption font-semibold text-text">After the previous result</h4>
          <WinRateComparison rows={afterRows} baseline={data.baseline.winRate} recordLabel={recordLabel} ariaLabel="Win rate after the previous result" />
          <p className="mt-3 border-t border-border pt-3 text-caption leading-relaxed text-text-muted">
            These are observed results in the same session. A difference does not establish tilt, confidence, or a benefit from continuing to play.
          </p>
        </section>
        <section className="min-w-0 rounded-lg border border-border bg-bg-elevated/30 p-3">
          <h4 className="mb-3 text-caption font-semibold text-text">Game number in the session</h4>
          {positions.length === 0 ? <p className="py-5 text-caption text-text-dim">No session-position data in this view yet.</p> : <>
            {initialPositions.length > 0 && <WinRateComparison rows={initialPositions} baseline={data.baseline.winRate} recordLabel={recordLabel} ariaLabel="Win rate by game number in session" />}
            {laterPositions.length > 0 && <details className="mt-3 border-t border-border pt-2">
              <summary className="min-h-11 cursor-pointer rounded py-3 text-caption font-medium text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{laterPositions.length === 1 ? `Later session game (${laterPositions[0].pos})` : `Later session games (${laterPositions[0].pos}–${laterPositions[laterPositions.length - 1].pos})`}</summary>
              <WinRateComparison rows={laterPositions} baseline={data.baseline.winRate} recordLabel={recordLabel} ariaLabel="Win rate in later session games" />
            </details>}
          </>}
          <p className="mt-3 border-t border-border pt-3 text-micro leading-relaxed text-text-dim">
            Later positions include only sessions that continued that far. Their players, opponents, and sample sizes can differ. The first 12 positions are available.
          </p>
        </section>
      </div>
    </Card>
  );
}
