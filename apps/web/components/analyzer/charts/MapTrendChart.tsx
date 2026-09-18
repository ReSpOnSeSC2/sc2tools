"use client";

import { useMemo, useState } from "react";
import { useTrendsApi as useApi, useTrendsDataScope } from "@/lib/trendsDataContext";
import { TrendsRequestError } from "./TrendsRequestError";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { MapArtwork } from "@/components/maps/MapArtwork";
import { MapPreviewDialog } from "@/components/maps/MapPreviewDialog";
import { clientTimezone, localDateKey } from "@/lib/timeseries";
import { buildWinRateTrend, type WinRatePeriod, type WinRateTrend } from "@/lib/winRateTrend";
import { WinRateSampleSummary, WinRateTrendPlot } from "./WinRateTrendPlot";

type MapPoint = {
  bucket: string;
  key: string;
  wins: number;
  losses: number;
  total: number;
};

type MapResponse = {
  interval: "day" | "week" | "month";
  points: MapPoint[];
};

type MapPanelData = { label: string; trend: WinRateTrend };

const TOP_N_OPTIONS = [4, 6, 8] as const;
const DEFAULT_TOP_N = 6;
const TARGET_GAMES = 20;

/**
 * Compare map form at a consistent sample size. Keep the requested interval
 * daily even when activity charts change grouping. Long API ranges can still
 * widen, so samples always retain whole returned periods.
 */
export function MapTrendChart(_props: { bucket: "day" | "week" | "month" }) {
  const { filters, dbRev } = useFilters();
  const { isGlobal } = useTrendsDataScope();
  const recordLabel = isGlobal ? "player game records" : "games";
  const tz = useMemo(() => clientTimezone(), []);
  const params = useMemo(
    () => ({ ...filters, interval: "day", tz }),
    [filters, tz],
  );
  const { data, isLoading, error, mutate } = useApi<MapResponse>(
    `/v1/timeseries/maps${filtersToQuery(params)}#${dbRev}`,
  );
  const [topN, setTopN] = useState<number>(DEFAULT_TOP_N);
  const [previewMap, setPreviewMap] = useState<string | null>(null);
  const { panels, dateDomain } = useMemo(
    () => shapeMaps(data?.points ?? [], tz, topN),
    [data, tz, topN],
  );

  if (error) return <TrendsRequestError title="Map performance over time" error={error} retry={mutate} />;

  if (isLoading) {
    return (
      <Card title="Map performance over time">
        <Skeleton rows={3} />
      </Card>
    );
  }

  if (panels.length === 0) {
    return (
      <Card title="Map performance over time">
        <EmptyState
          title="No map data to chart yet"
          sub="Map form appears when the selected records include games with map information."
        />
      </Card>
    );
  }

  const periodLabel = data?.interval === "week" ? "weeks" : data?.interval === "month" ? "months" : "days";

  return (
    <>
      <Card title="Map performance over time" className="min-w-0">
        <div className="mb-4 flex min-w-0 flex-wrap items-start justify-between gap-3">
          <p className="min-w-0 flex-1 basis-64 text-caption leading-relaxed text-text-muted">
            Recent form from at least {TARGET_GAMES} {recordLabel} per map. Smaller samples stay in the building stage.
          </p>
          <div role="group" aria-label="Number of maps to show" className="flex shrink-0 items-center gap-1 text-caption">
            <span className="mr-1 text-text-muted">Top</span>
            {TOP_N_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                aria-label={`Show top ${n} maps`}
                aria-pressed={topN === n}
                onClick={() => setTopN(n)}
                className={[
                  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-3 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface",
                  topN === n
                    ? "bg-accent/15 text-accent ring-1 ring-inset ring-accent/40"
                    : "bg-bg-elevated text-text-muted hover:text-text",
                ].join(" ")}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {panels.map((panel) => (
            <MapPanel key={panel.label} panel={panel} recordLabel={recordLabel} interval={data?.interval ?? "day"} dateDomain={dateDomain} onOpenPreview={setPreviewMap} />
          ))}
        </div>
        <p className="mt-4 text-micro leading-relaxed text-text-dim">
          Maps ranked by volume in this range. Samples keep whole {periodLabel}, so the count can exceed {TARGET_GAMES}. Each {isGlobal ? "player game record" : "game"} has equal weight.
        </p>
      </Card>
      <MapPreviewDialog mapName={previewMap} onClose={() => setPreviewMap(null)} />
    </>
  );
}

function MapPanel({
  panel,
  recordLabel,
  interval,
  dateDomain,
  onOpenPreview,
}: {
  panel: MapPanelData;
  recordLabel: string;
  interval: "day" | "week" | "month";
  dateDomain: [string, string] | undefined;
  onOpenPreview: (mapName: string) => void;
}) {
  const { overall } = panel.trend;
  return (
    <div className="min-w-0 rounded-xl border border-border bg-bg-elevated/40 p-3 sm:p-4">
      <div className="mb-3 flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          aria-label={`View a larger image of ${panel.label}`}
          aria-haspopup="dialog"
          title={`View larger map: ${panel.label}`}
          onClick={() => onOpenPreview(panel.label)}
          className="group/map inline-flex min-h-11 min-w-11 shrink-0 cursor-zoom-in items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-elevated"
        >
          <MapArtwork mapName={panel.label} size="md" alt="" className="rounded-lg" />
        </button>
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-caption font-semibold text-text" title={panel.label}>
            {panel.label}
          </h4>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-micro tabular-nums text-text-muted">
            <span>{overall.rate == null ? "—" : `${Math.round(overall.rate)}%`} overall</span>
            <span>{overall.games.toLocaleString()} {overall.games === 1 ? recordLabel.slice(0, -1) : recordLabel}</span>
          </div>
        </div>
      </div>
      <WinRateSampleSummary trend={panel.trend} targetGames={TARGET_GAMES} compact recordLabel={recordLabel} interval={interval} />
      <WinRateTrendPlot trend={panel.trend} compact label={`${panel.label} recent win rate`} recordLabel={recordLabel} interval={interval} dateDomain={dateDomain} />
    </div>
  );
}

function shapeMaps(points: MapPoint[], tz: string, topN: number): {
  panels: MapPanelData[];
  dateDomain: [string, string] | undefined;
} {
  const byMap = new Map<string, WinRatePeriod[]>();
  const dates = new Set<string>();
  for (const point of points) {
    const date = localDateKey(point.bucket, tz);
    if (!date) continue;
    dates.add(date);
    const periods = byMap.get(point.key) ?? [];
    // Keep every row: the shared helper coalesces duplicate map/date records.
    periods.push({ date, wins: point.wins, losses: point.losses, games: point.total });
    byMap.set(point.key, periods);
  }
  const sortedDates = [...dates].sort();
  const panels = [...byMap.entries()]
    .map(([label, periods]) => ({
      label,
      trend: buildWinRateTrend(periods, TARGET_GAMES),
    }))
    .filter((panel) => panel.trend.overall.games > 0)
    .sort((a, b) => b.trend.overall.games - a.trend.overall.games || a.label.localeCompare(b.label))
    .slice(0, topN);
  return {
    panels,
    dateDomain: sortedDates.length ? [sortedDates[0], sortedDates[sortedDates.length - 1]] : undefined,
  };
}
