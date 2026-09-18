"use client";

import { useMemo } from "react";
import { useTrendsApi as useApi, useTrendsDataScope } from "@/lib/trendsDataContext";
import { TrendsRequestError } from "./TrendsRequestError";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { WinRateComparison } from "./WinRateComparison";

type LengthBucket = "0–3m" | "3–6m" | "6–9m" | "9–12m" | "12–15m" | "15–20m" | "20–25m" | "25m+";
type LengthBucketRow = { bucket: LengthBucket; wins: number; losses: number; total: number; winRate: number; avgSec: number };
type LengthBucketResponse = { buckets: LengthBucketRow[] };
const ORDER: LengthBucket[] = ["0–3m", "3–6m", "6–9m", "9–12m", "12–15m", "15–20m", "20–25m", "25m+"];

export function GameLengthWrChart() {
  const { filters, dbRev } = useFilters();
  const { isGlobal } = useTrendsDataScope();
  const { data, isLoading, error, mutate } = useApi<LengthBucketResponse>(`/v1/length-buckets${filtersToQuery(filters)}#${dbRev}`);
  const rows = useMemo(() => {
    const byBucket = new Map((data?.buckets ?? []).map((row) => [row.bucket, row]));
    return ORDER.map((bucket) => {
      const row = byBucket.get(bucket);
      return {
        key: bucket,
        label: bucket,
        rate: row && row.total > 0 ? row.winRate : null,
        games: row?.total ?? 0,
        wins: row?.wins ?? 0,
        losses: row?.losses ?? 0,
      };
    });
  }, [data]);
  const totalGames = rows.reduce((sum, row) => sum + row.games, 0);
  const overallRate = totalGames > 0 ? rows.reduce((sum, row) => sum + row.wins, 0) / totalGames : null;
  const hasOther = rows.some((row) => row.games > row.wins + row.losses);

  if (error) return <TrendsRequestError title="Win rate by game length" error={error} retry={mutate} />;
  if (isLoading) return <Card title="Win rate by game length"><Skeleton rows={3} /></Card>;
  if (totalGames === 0) return (
    <Card title="Win rate by game length">
      <EmptyState title="No games to bucket" sub="Game-length analysis becomes useful once a few games of varied length are on record." />
    </Card>
  );

  return (
    <Card title="Win rate by game length">
      <p className="-mt-1 mb-3 text-caption leading-relaxed text-text-muted">
        Compare short and long games on the same scale. Each row includes its record, so a rare long game carries its sample size with it.
      </p>
      <WinRateComparison rows={rows} baseline={overallRate} baselineLabel="All lengths" recordLabel={isGlobal ? "player game records" : "games"} ariaLabel="Win rate by recorded game duration" />
      <p className="mt-3 border-t border-border pt-3 text-micro leading-relaxed text-text-dim">
        Duration describes when games ended; it does not show that extending a game improves the chance of winning.
        {hasOther ? " Other records have no win/loss result and remain in the win-rate denominator." : ""}
      </p>
    </Card>
  );
}
