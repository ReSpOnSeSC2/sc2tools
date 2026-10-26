"use client";

import { useMemo } from "react";
import { EmptyState } from "@/components/ui/Card";
import { ChartFrame, type ChartTableColumn } from "@/components/analyzer/charts/ChartFrame";
import { WinRateComparison, type WinRateComparisonRow } from "@/components/analyzer/charts/WinRateComparison";
import { isLowSample } from "@/lib/charts/theme";

export type MmrBucketRow = {
  series: string;
  bucket: number;
  label: string;
  wins: number;
  losses: number;
  games: number;
};

type BucketTableRow = WinRateComparisonRow & { band: string; series: string; decided: number; belowMinimum: boolean };
type BucketBand = { bucket: number; label: string; rows: BucketTableRow[] };
const COLUMNS: readonly ChartTableColumn<BucketTableRow>[] = [
  { key: "band", label: "MMR band", render: row => row.band },
  { key: "series", label: "Build or strategy", render: row => row.series },
  { key: "rate", label: "Win rate", render: row => row.rate == null ? "Below minimum" : `${Math.round(row.rate * 100)}%`, align: "right" },
  { key: "wins", label: "Wins", render: row => row.wins, align: "right" },
  { key: "losses", label: "Losses", render: row => row.losses, align: "right" },
  { key: "games", label: "Tagged games", render: row => row.games, align: "right" },
  { key: "sample", label: "Decided sample", render: row => `${row.decided}${isLowSample(row.decided) ? " · small sample" : ""}`, align: "right" },
];

/** MMR bands are categories on a common 0–100% comparison scale.
 * The existing rate denominator and tagged-game minimum remain unchanged;
 * decided counts independently qualify the visible small-sample cue. */
export function MmrBucketChart({ rows, minSampleSize, height = 280, emptyTitle, emptySub }: {
  rows: MmrBucketRow[]; minSampleSize: number; height?: number; emptyTitle?: string; emptySub?: string;
}) {
  const { bands, totalGames } = useMemo(() => shapeBucketComparisons(rows, minSampleSize), [rows, minSampleSize]);
  const tableRows = totalGames === 0 ? [] : bands.flatMap(band => band.rows);
  const summary = `${totalGames} MMR-tagged games across ${bands.length} bands. Win rates use all tagged games; rates need at least ${minSampleSize} tagged games per build or strategy in a band. Small samples have fewer than 20 decided games.`;
  return <ChartFrame title="Win rate by MMR band" summary={summary} rows={tableRows} columns={COLUMNS}
    empty={<EmptyState title={emptyTitle || "No MMR-tagged games yet"} sub={emptySub || "Charts populate as games ingest with both your MMR and the opponent's MMR (both required to bucket honestly)."} />}>
    <p className="mb-3 text-caption text-text-muted">Current filters apply. Minimum {minSampleSize} tagged games per row; win rate uses wins ÷ tagged games. Hollow markers indicate fewer than 20 decided games.</p>
    <div className="space-y-6" style={{ minHeight: Math.min(height, 280) }}>
      {bands.map(band => <section key={`${band.bucket}:${band.label}`} aria-label={`${band.label} MMR`}>
        <h3 className="mb-2 text-caption font-semibold text-text">{band.label} MMR</h3>
        <WinRateComparison rows={band.rows} baseline={0.5} baselineLabel="50% reference" recordLabel="tagged games" separateCount ariaLabel={`${band.label} MMR comparison`} />
      </section>)}
    </div>
  </ChartFrame>;
}

/** Keep the prior last-row-per-band projection and total-volume ordering.
 * Repeated input rows still contribute to volume, while a band cell retains
 * its last supplied value, matching the previous chart shaper. */
export function shapeBucketComparisons(rows: MmrBucketRow[], minSampleSize: number): { bands: BucketBand[]; totalGames: number } {
  const buckets = new Map<string, { bucket: number; label: string }>();
  const series = new Map<string, { cells: Map<string, MmrBucketRow>; totalGames: number }>();
  for (const row of rows) {
    if (!buckets.has(row.label)) buckets.set(row.label, { bucket: row.bucket, label: row.label });
    let group = series.get(row.series);
    if (!group) { group = { cells: new Map(), totalGames: 0 }; series.set(row.series, group); }
    group.cells.set(row.label, row); group.totalGames += row.games;
  }
  const sortedSeries = [...series].sort((a, b) => b[1].totalGames - a[1].totalGames);
  const bands = [...buckets.values()].sort((a, b) => a.bucket - b.bucket).map(band => ({ ...band,
    rows: sortedSeries.map(([name, group]) => {
      const cell = group.cells.get(band.label), games = cell?.games || 0, wins = cell?.wins || 0, losses = cell?.losses || 0;
      const belowMinimum = !cell || games < minSampleSize;
      return { key: `${band.bucket}:${band.label}:${name}`, band: band.label, series: name, label: name,
        wins, losses, games, decided: wins + losses, belowMinimum,
        rate: belowMinimum ? null : Math.round(wins / games * 100) / 100,
        detail: belowMinimum ? `Below the current minimum of ${minSampleSize} tagged games.` : undefined };
    }),
  }));
  return { bands, totalGames: [...series.values()].reduce((sum, group) => sum + group.totalGames, 0) };
}
