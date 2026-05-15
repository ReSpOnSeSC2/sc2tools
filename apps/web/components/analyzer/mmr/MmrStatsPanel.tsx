"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useLocalStoragePositiveInt } from "@/lib/useLocalStorageState";
import { Card, Skeleton } from "@/components/ui/Card";
import { MinGamesPicker } from "@/components/ui/MinGamesPicker";
import { MmrBucketChart, type MmrBucketRow } from "./MmrBucketChart";
import { MmrRangeFilter } from "./MmrRangeFilter";

interface ServerBucket {
  bucket: number;
  label: string;
  wins: number;
  losses: number;
  games: number;
  // ``build`` for the my-build cut, ``strategy`` for the opp cut.
  build?: string;
  strategy?: string;
}

interface BucketResponse {
  bucketWidth: number;
  buckets: ServerBucket[];
}

export interface MmrStatsPanelProps {
  /** Card heading shown above the controls. */
  title: string;
  /** Sub-heading paragraph beneath the title. */
  subtitle?: string;
  /** API path (without query string). */
  endpoint: "/v1/mmr-stats/builds" | "/v1/mmr-stats/strategies";
  /** Which field on the response identifies the series. */
  seriesKey: "build" | "strategy";
  /** Human label for "items in legend" in the top-N picker. */
  seriesLabel: string;
  /** localStorage namespace; the panel writes three suffixed keys. */
  storageNamespace: string;
  /** Show when the dataset is empty. */
  emptyTitle?: string;
  emptySub?: string;
}

/**
 * Shared MMR-bucket panel that drives both the Builds and Strategies
 * tab charts. The only differences between the two are the
 * endpoint, the legend label, and the storage namespace — every
 * piece of UX (controls, filters, chart, persistence, empty state)
 * is identical so the two tabs read as the same primitive
 * applied to two different cuts of the data.
 *
 * Three locally-controlled filters live on the panel (they don't
 * belong on the global FilterBar — they're chart-specific):
 *   * MMR Δ — mirror-MMR window. Customisable; the underlying
 *     ``MmrRangeFilter`` accepts ±50, ±150, ±300, custom, or off.
 *   * Min games per bucket — the sample-size gate. Reuses
 *     ``MinGamesPicker`` so chips match Opponents tab.
 *   * Top N — caps the legend to the busiest N series so a streamer
 *     who plays 30 builds doesn't drown the chart.
 *
 * Production safety:
 *   * No mock data. The server returns only what's in the database;
 *     an empty response renders an EmptyState pointing at the
 *     actual gap.
 *   * All three filter values persist in localStorage so the
 *     panel remembers the user's preferred slice across reloads.
 *   * Mobile-first: every control wraps cleanly; the chart's own
 *     ResponsiveContainer + rotated x-ticks handle the rest.
 */
export function MmrStatsPanel({
  title,
  subtitle,
  endpoint,
  seriesKey,
  seriesLabel,
  storageNamespace,
  emptyTitle,
  emptySub,
}: MmrStatsPanelProps) {
  const { filters, dbRev } = useFilters();
  const [minGames, setMinGames] = useLocalStoragePositiveInt(
    `${storageNamespace}.minGames`,
    5,
  );
  const [topN, setTopN] = useLocalStoragePositiveInt(
    `${storageNamespace}.topN`,
    6,
  );
  const [mmrDelta, setMmrDelta] = useStoredMmrDelta(
    `${storageNamespace}.mmrDelta`,
  );

  const query = useMemo(() => {
    const params: Record<string, unknown> = { ...filters };
    if (mmrDelta != null) params.mmr_delta = mmrDelta;
    return filtersToQuery(params);
  }, [filters, mmrDelta]);

  const { data, isLoading } = useApi<BucketResponse>(
    `${endpoint}${query}#${dbRev}`,
  );

  const rows: MmrBucketRow[] = useMemo(() => {
    const buckets = data?.buckets || [];
    if (buckets.length === 0) return [];
    const totalsBySeries = new Map<string, number>();
    for (const b of buckets) {
      const name = String(b[seriesKey] || "Unknown");
      totalsBySeries.set(name, (totalsBySeries.get(name) || 0) + b.games);
    }
    const allowed = new Set(
      Array.from(totalsBySeries.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([name]) => name),
    );
    return buckets
      .filter((b) => allowed.has(String(b[seriesKey] || "Unknown")))
      .map((b) => ({
        series: String(b[seriesKey] || "Unknown"),
        bucket: b.bucket,
        label: b.label,
        wins: b.wins,
        losses: b.losses,
        games: b.games,
      }));
  }, [data, topN, seriesKey]);

  return (
    <Card title={title}>
      {subtitle ? (
        <p className="-mt-1 mb-3 text-caption text-text-dim">{subtitle}</p>
      ) : null}
      <PanelControls
        minGames={minGames}
        onMinGames={setMinGames}
        topN={topN}
        onTopN={setTopN}
        topNLabel={seriesLabel}
        mmrDelta={mmrDelta}
        onMmrDelta={setMmrDelta}
      />
      <div className="mt-4">
        {isLoading ? (
          <Skeleton rows={4} />
        ) : (
          <MmrBucketChart
            rows={rows}
            minSampleSize={minGames}
            emptyTitle={emptyTitle}
            emptySub={emptySub}
          />
        )}
      </div>
    </Card>
  );
}

function PanelControls({
  minGames,
  onMinGames,
  topN,
  onTopN,
  topNLabel,
  mmrDelta,
  onMmrDelta,
}: {
  minGames: number;
  onMinGames: (n: number) => void;
  topN: number;
  onTopN: (n: number) => void;
  topNLabel: string;
  mmrDelta: number | undefined;
  onMmrDelta: (n: number | undefined) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-text-dim">
          Min games per bucket
        </span>
        <MinGamesPicker value={minGames} onChange={onMinGames} hideLabel />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-text-dim">
          {topNLabel} shown (top N by volume)
        </span>
        <MinGamesPicker
          value={topN}
          onChange={onTopN}
          steps={[3, 6, 10, 20]}
          hideLabel
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-text-dim">
          MMR Δ between players
        </span>
        <MmrRangeFilter value={mmrDelta} onChange={onMmrDelta} />
      </div>
    </div>
  );
}

/**
 * Tri-state localStorage hook for the MMR-Δ filter, which can be a
 * positive integer (delta on) or ``undefined`` (filter off). The
 * "off" state is represented by the absence of the key in storage.
 */
function useStoredMmrDelta(
  key: string,
): [number | undefined, (next: number | undefined) => void] {
  const [value, setValue] = useState<number | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw == null) return undefined;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    } catch {
      return undefined;
    }
  });
  const update = (next: number | undefined) => {
    setValue(next);
    if (typeof window === "undefined") return;
    try {
      if (next == null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, String(next));
    } catch {
      /* non-fatal */
    }
  };
  return [value, update];
}
