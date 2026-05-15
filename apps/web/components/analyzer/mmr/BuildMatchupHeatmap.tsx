"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useLocalStoragePositiveInt } from "@/lib/useLocalStorageState";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { MinGamesPicker } from "@/components/ui/MinGamesPicker";
import { fmtMmr, pct1, wrColor } from "@/lib/format";
import { MmrRangeFilter } from "./MmrRangeFilter";

interface ServerCell {
  build: string;
  strategy: string;
  bucket: number;
  label: string;
  wins: number;
  losses: number;
  games: number;
}

interface ServerResponse {
  bucketWidth: number;
  cells: ServerCell[];
}

const LS_MIN_GAMES = "analyzer.mmr.heatmap.minGames";
const LS_MMR_DELTA = "analyzer.mmr.heatmap.mmrDelta";
const LS_BUCKET = "analyzer.mmr.heatmap.bucket";

/**
 * Build × Strategy × MMR heatmap. The third dimension (MMR bucket)
 * lives in a selector above the grid — the user picks "show me the
 * matchup at 4400-MMR" and the heatmap re-paints. Two reasons not
 * to flatten all three dimensions onto the same screen at once:
 *
 *   * A full 3D rendering (build × strategy × MMR) explodes into
 *     hundreds of cells and stops being scannable.
 *   * Mobile width can't carry a meaningful 2D grid AND an MMR
 *     dimension. Picking one bucket keeps the grid compact at any
 *     viewport.
 *
 * Cell colour is the WR ramp; cell label is the WR % plus a small
 * sample-size hint. Cells under the min-games gate are greyed out
 * rather than coloured — same data-quality discipline as the line
 * charts.
 *
 * Mobile-first:
 *   * Grid horizontally scrolls within its container; sticky first
 *     column keeps the build name visible while scanning strategies.
 *   * Touch targets are at least 44 px tall so accidental scrolling
 *     doesn't fire cell clicks.
 *
 * No mock data: empty response → EmptyState with the precise gap
 * ("no MMR-tagged matchups in this bucket yet").
 */
export function BuildMatchupHeatmap() {
  const { filters, dbRev } = useFilters();
  const [minGames, setMinGames] = useLocalStoragePositiveInt(LS_MIN_GAMES, 3);
  const [mmrDelta, setMmrDelta] = useStoredMmrDelta(LS_MMR_DELTA);
  const [selectedBucket, setSelectedBucket] = useStoredBucket(LS_BUCKET);

  const query = useMemo(() => {
    const params: Record<string, unknown> = { ...filters };
    if (mmrDelta != null) params.mmr_delta = mmrDelta;
    return filtersToQuery(params);
  }, [filters, mmrDelta]);

  const { data, isLoading } = useApi<ServerResponse>(
    `/v1/mmr-stats/build-vs-strategy${query}#${dbRev}`,
  );

  const bucketStats = useMemo(() => {
    const counts = new Map<number, { label: string; games: number }>();
    for (const c of data?.cells || []) {
      const cur = counts.get(c.bucket);
      if (cur) cur.games += c.games;
      else counts.set(c.bucket, { label: c.label, games: c.games });
    }
    return Array.from(counts.entries())
      .map(([bucket, v]) => ({ bucket, label: v.label, games: v.games }))
      .sort((a, b) => a.bucket - b.bucket);
  }, [data]);

  const activeBucket = useMemo(() => {
    if (bucketStats.length === 0) return null;
    if (selectedBucket != null) {
      const hit = bucketStats.find((b) => b.bucket === selectedBucket);
      if (hit) return hit.bucket;
    }
    // Default: the bucket with the most games. Surfaces the user's
    // actual ladder home rather than the tail.
    return bucketStats.reduce(
      (best, b) => (b.games > best.games ? b : best),
      bucketStats[0],
    ).bucket;
  }, [bucketStats, selectedBucket]);

  const grid = useMemo(() => {
    if (activeBucket == null) {
      return { builds: [], strategies: [], cellByKey: new Map() };
    }
    const cells = (data?.cells || []).filter(
      (c) => c.bucket === activeBucket,
    );
    const buildsSet = new Map<string, number>();
    const strategiesSet = new Map<string, number>();
    const cellByKey = new Map<string, ServerCell>();
    for (const c of cells) {
      buildsSet.set(c.build, (buildsSet.get(c.build) || 0) + c.games);
      strategiesSet.set(
        c.strategy,
        (strategiesSet.get(c.strategy) || 0) + c.games,
      );
      cellByKey.set(`${c.build}|${c.strategy}`, c);
    }
    const builds = Array.from(buildsSet.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
    const strategies = Array.from(strategiesSet.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
    return { builds, strategies, cellByKey };
  }, [data, activeBucket]);

  return (
    <Card title="Build × Strategy heatmap by MMR">
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        Each cell is your win rate with that build vs that opponent strategy at
        the selected MMR bucket. Cells with fewer games than the min-games
        gate are greyed out so small samples don't mislead.
      </p>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-text-dim">
            MMR bucket
          </span>
          {bucketStats.length > 0 ? (
            <BucketChips
              buckets={bucketStats}
              active={activeBucket}
              onPick={setSelectedBucket}
            />
          ) : (
            <span className="text-xs text-text-dim">no MMR data yet</span>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-text-dim">
            Min games per cell
          </span>
          <MinGamesPicker value={minGames} onChange={setMinGames} hideLabel />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-text-dim">
            MMR Δ between players
          </span>
          <MmrRangeFilter value={mmrDelta} onChange={setMmrDelta} />
        </div>
      </div>

      <div className="mt-4">
        {isLoading ? (
          <Skeleton rows={4} />
        ) : grid.builds.length === 0 ? (
          <EmptyState
            title="No matchups in this bucket yet"
            sub="Heatmap populates as games ingest with both your MMR and the opponent's MMR. Try another bucket above, or wait for more data."
          />
        ) : (
          <HeatmapGrid
            builds={grid.builds}
            strategies={grid.strategies}
            cellByKey={grid.cellByKey}
            minGames={minGames}
          />
        )}
      </div>
    </Card>
  );
}

function BucketChips({
  buckets,
  active,
  onPick,
}: {
  buckets: Array<{ bucket: number; label: string; games: number }>;
  active: number | null;
  onPick: (n: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {buckets.map((b) => {
        const on = active === b.bucket;
        return (
          <button
            key={b.bucket}
            type="button"
            onClick={() => onPick(b.bucket)}
            aria-pressed={on}
            className={[
              "inline-flex min-h-[28px] items-center gap-1 rounded-full border px-2 py-0.5",
              "text-[11px] font-medium tabular-nums",
              "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
              on
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-border text-text-dim hover:bg-bg-elevated hover:text-text",
            ].join(" ")}
          >
            <span className="uppercase tracking-wider">{b.label}</span>
            <span className="text-[10px] text-text-dim/70">
              · {b.games}g
            </span>
          </button>
        );
      })}
    </div>
  );
}

function HeatmapGrid({
  builds,
  strategies,
  cellByKey,
  minGames,
}: {
  builds: string[];
  strategies: string[];
  cellByKey: Map<string, ServerCell>;
  minGames: number;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 min-w-[10rem] border-b border-border bg-bg-surface px-2 py-2 text-left text-text-dim">
              Build / Strategy
            </th>
            {strategies.map((s) => (
              <th
                key={s}
                className="border-b border-border px-2 py-2 text-left align-bottom text-text-dim"
                style={{ minWidth: "5.5rem", maxWidth: "9rem" }}
                title={s}
              >
                <div className="truncate" style={{ maxWidth: "8rem" }}>
                  {s}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {builds.map((b) => (
            <tr key={b}>
              <th
                className="sticky left-0 z-10 max-w-[12rem] border-b border-border bg-bg-surface px-2 py-2 text-left text-text"
                title={b}
                scope="row"
              >
                <div className="truncate">{b}</div>
              </th>
              {strategies.map((s) => {
                const cell = cellByKey.get(`${b}|${s}`);
                return (
                  <HeatCell key={`${b}|${s}`} cell={cell} minGames={minGames} />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HeatCell({
  cell,
  minGames,
}: {
  cell: ServerCell | undefined;
  minGames: number;
}) {
  if (!cell) {
    return (
      <td className="min-h-[44px] border-b border-border px-2 py-1.5 text-center text-text-dim/40">
        —
      </td>
    );
  }
  const winRate = cell.games > 0 ? cell.wins / cell.games : 0;
  if (cell.games < minGames) {
    return (
      <td className="min-h-[44px] border-b border-border px-2 py-1.5 text-center text-text-dim/50">
        <div className="text-[11px] tabular-nums">{pct1(winRate)}</div>
        <div className="text-[9px] text-text-dim/50">
          {cell.games}g (low)
        </div>
      </td>
    );
  }
  const color = wrColor(winRate, cell.games);
  return (
    <td
      className="min-h-[44px] border-b border-border bg-bg-elevated/40 px-2 py-1.5 text-center"
      title={`${cell.wins}W ${cell.losses}L · ${cell.games} games · @${fmtMmr(cell.bucket)} MMR`}
    >
      <div
        className="text-[12px] font-semibold tabular-nums"
        style={{ color }}
      >
        {pct1(winRate)}
      </div>
      <div className="text-[10px] text-text-dim">
        {cell.wins}–{cell.losses} · {cell.games}g
      </div>
    </td>
  );
}

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

function useStoredBucket(
  key: string,
): [number | null, (n: number) => void] {
  const [value, setValue] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw == null) return null;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  });
  const update = (next: number) => {
    setValue(next);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, String(next));
    } catch {
      /* non-fatal */
    }
  };
  return [value, update];
}
