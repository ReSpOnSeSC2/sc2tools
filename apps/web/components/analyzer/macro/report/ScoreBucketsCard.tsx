"use client";

import { Card, EmptyState } from "@/components/ui/Card";
import { ChartFrame, type ChartTableColumn } from "../../charts/ChartFrame";
import { WinRateComparison } from "../../charts/WinRateComparison";
import type { ReportDrill, ScoreBucketRow } from "./types";

/** Category bands share one percentage scale; counts have their own column.
 * The endpoint's rates and exact macro drill boundaries remain unchanged. */
export function ScoreBucketsCard({ buckets, onDrill }: { buckets: ScoreBucketRow[]; onDrill: (drill: ReportDrill) => void }) {
  const total = buckets.reduce((sum, row) => sum + row.games, 0);
  const drillFor = (row: ScoreBucketRow): ReportDrill => ({ title: `Games with macro ${row.label}`, params: {
    ...(row.min !== null ? { macro_min: row.min } : {}), ...(row.max !== null ? { macro_max: row.max } : {}),
  } });
  const columns: ChartTableColumn<ScoreBucketRow>[] = [
    { key: "label", label: "Macro score", render: row => <button type="button" className="min-h-11 text-accent underline" disabled={!row.games} onClick={() => onDrill(drillFor(row))}>{row.label}</button> },
    { key: "rate", label: "Win rate", align: "right", render: row => row.winRate == null ? "—" : `${Math.round(row.winRate * 100)}%` },
    { key: "games", label: "Games", align: "right", render: row => row.games.toLocaleString() },
    { key: "record", label: "Record", render: row => `${row.wins}W · ${row.losses}L${row.games > row.wins + row.losses ? ` · ${row.games - row.wins - row.losses} other` : ""}` },
  ];
  return <Card title="Macro score and results">
    <p className="-mt-1 mb-3 text-caption text-text-muted">Recorded win rates by macro-score band. Groups can differ in opposition and game length; this comparison does not establish cause.</p>
    <ChartFrame title="Macro score and results" summary={`${total} scored games across ${buckets.length} macro-score bands. Rates and counts use the same recorded groups; fewer than 20 decided results are marked as small samples.`}
      rows={total ? buckets : []} columns={columns} empty={<EmptyState title="No scored games yet" sub="Macro scores appear as the agent uploads (or backfills) replays." />}>
      <WinRateComparison separateCount baseline={0.5} baselineLabel="Reference" ariaLabel="Win rate by macro-score band"
        rows={buckets.map(row => ({ key: row.key, label: row.label, rate: row.winRate, games: row.games, wins: row.wins, losses: row.losses,
          onSelect: row.games ? () => onDrill(drillFor(row)) : undefined, ariaLabel: `Games with macro ${row.label}` }))} />
    </ChartFrame>
  </Card>;
}
