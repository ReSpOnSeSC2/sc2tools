"use client";

import { useMemo, useState } from "react";
import { useTrendsApi as useApi, useTrendsDataScope } from "@/lib/trendsDataContext";
import { TrendsRequestError } from "./TrendsRequestError";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { OppMmrBucketGamesModal } from "./OppMmrBucketGamesModal";
import { WinRateComparison } from "./WinRateComparison";

type SelectedBand = {
  lo: number;
  hi: number;
  wins: number;
  losses: number;
  total: number;
};

type OppMmrBucket = SelectedBand & {
  label: string;
  winRate: number;
  avgMmr: number | null;
  minMmr: number | null;
  maxMmr: number | null;
};

// Keep in step with OPP_MMR_BUCKET_WIDTHS in services/trendsOppMmr.
const BUCKET_WIDTHS = [50, 100, 300, 500] as const;
type BucketWidth = (typeof BUCKET_WIDTHS)[number];
type WidthMode = "auto" | BucketWidth;
type Response = {
  bucketWidth: BucketWidth;
  buckets: OppMmrBucket[];
  unknown: { total: number; wins: number; losses: number };
};

/** Absolute rating brackets are categories, not a continuous WR trend. */
export function OppMmrBucketsChart() {
  const { isGlobal } = useTrendsDataScope();
  const { filters, dbRev } = useFilters();
  const [widthMode, setWidthMode] = useState<WidthMode>(500);
  const [selectedBand, setSelectedBand] = useState<SelectedBand | null>(null);
  const query = useMemo(() => ({ ...filters, bucket_width: widthMode }), [filters, widthMode]);
  const { data, isLoading, error, mutate } = useApi<Response>(
    `/v1/opp-mmr-buckets${filtersToQuery(query)}#${dbRev}`,
  );
  const { totalKnown, baseline } = useMemo(() => {
    const buckets = data?.buckets || [];
    const total = buckets.reduce((sum, b) => sum + b.total, 0);
    const wins = buckets.reduce((sum, b) => sum + b.wins, 0);
    return { totalKnown: total, baseline: total > 0 ? wins / total : null };
  }, [data]);

  if (error) return <TrendsRequestError title="Win rate by opponent MMR" error={error} retry={mutate} />;
  if (isLoading) return <Card title="Win rate by opponent MMR"><Skeleton rows={3} /></Card>;
  if (!data || totalKnown === 0) {
    return <Card title="Win rate by opponent MMR"><EmptyState
      title="No MMR-tagged games"
      sub="Replays with opponent MMR show win rate across absolute MMR brackets."
    /></Card>;
  }

  return (
    <Card title="Win rate by opponent MMR">
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        Compare {data.bucketWidth}-MMR bands on the same win-rate scale. Wider bands combine more games;
        narrower bands show more detail. Tap a played band to inspect its games.
      </p>
      <div className="mb-3">
        <WidthToggle value={widthMode} actualWidth={data.bucketWidth} onChange={setWidthMode} />
      </div>
      <WinRateComparison
        ariaLabel="Win rate by opponent MMR band"
        baseline={baseline}
        baselineLabel="Rated opponents overall"
        recordLabel={isGlobal ? "player game records" : "games"}
        rows={data.buckets.map((b) => ({
          key: String(b.lo),
          label: `${b.lo}–${b.hi - 1}`,
          rate: b.total > 0 ? b.winRate : null,
          games: b.total,
          wins: b.wins,
          losses: b.losses,
          detail: b.avgMmr != null && b.total > 0 ? `Average opponent ${Math.round(b.avgMmr).toLocaleString()} MMR` : undefined,
          ariaLabel: `List the ${b.total} ${isGlobal ? "player game record" : "game"}${b.total === 1 ? "" : "s"} against ${b.lo}–${b.hi - 1} MMR opponents`,
          onSelect: b.total > 0 ? () => setSelectedBand({ lo: b.lo, hi: b.hi, wins: b.wins, losses: b.losses, total: b.total }) : undefined,
        }))}
      />
      <p className="mt-3 text-micro text-text-dim">
        {totalKnown.toLocaleString()} {isGlobal ? "player game record" : "game"}{totalKnown === 1 ? "" : "s"} with opponent MMR
        {data.unknown.total > 0 ? ` · ${data.unknown.total.toLocaleString()} with missing opponent MMR excluded` : ""}.
      </p>
      <details className="mt-2 text-micro text-text-dim">
        <summary className="cursor-pointer py-1 font-medium text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Which games are included?</summary>
        <p className="mt-1 leading-relaxed">
          Only games from the last 12 months are grouped. Older games lack trustworthy game-time opponent
          MMR, so they count as missing MMR. The reference is the win rate across the rated games in this view.
          Absolute rating brackets can also reflect changes in the selected players’ own ratings over time.
        </p>
      </details>
      <OppMmrBucketGamesModal band={selectedBand} onClose={() => setSelectedBand(null)} />
    </Card>
  );
}

function WidthToggle({ value, actualWidth, onChange }: {
  value: WidthMode;
  actualWidth: BucketWidth;
  onChange: (mode: WidthMode) => void;
}) {
  const options: Array<{ id: WidthMode; label: string; aria: string; sub?: string }> = [
    { id: "auto", label: "Auto", aria: "Choose the band width automatically", sub: value === "auto" ? `${actualWidth}` : undefined },
    ...BUCKET_WIDTHS.map((width) => ({ id: width, label: String(width), aria: `Group opponents into ${width}-MMR bands` })),
  ];
  return (
    <div role="group" aria-label="Opponent MMR band width" className="flex flex-wrap items-center gap-1 text-micro">
      <span className="mr-1 text-text-dim">Band width</span>
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => onChange(opt.id)}
          aria-pressed={value === opt.id}
          aria-label={opt.aria}
          className={`min-h-11 min-w-11 rounded-md px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${value === opt.id ? "bg-accent/15 text-accent ring-1 ring-accent/40" : "bg-bg-elevated text-text-dim hover:text-text"}`}
        >
          {opt.label}
          {opt.sub ? <span className="ml-1 tabular-nums text-text-dim">({opt.sub})</span> : null}
        </button>
      ))}
    </div>
  );
}
