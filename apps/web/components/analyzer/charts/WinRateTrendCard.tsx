"use client";

import { useMemo, useState } from "react";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useTrendsApi, useTrendsDataScope } from "@/lib/trendsDataContext";
import { apiToPeriods, clientTimezone, type ApiTimeseriesResponse } from "@/lib/timeseries";
import { buildWinRateTrend, type WinRateSampleTarget } from "@/lib/winRateTrend";
import { TrendsRequestError } from "./TrendsRequestError";
import { WinRateSampleSummary, WinRateSampleToggle, WinRateTrendPlot } from "./WinRateTrendPlot";

export function WinRateTrendCard() {
  const { filters, dbRev } = useFilters();
  const { isGlobal } = useTrendsDataScope();
  const [target, setTarget] = useState<WinRateSampleTarget>(30);
  const tz = useMemo(() => clientTimezone(), []);
  // Activity grouping must not turn a small calendar bucket into the main signal.
  const params = useMemo(() => ({ ...filters, interval: "day", tz }), [filters, tz]);
  const { data, isLoading, error, mutate } = useTrendsApi<ApiTimeseriesResponse>(`/v1/timeseries${filtersToQuery(params)}#${dbRev}`);
  const trend = useMemo(() => buildWinRateTrend(apiToPeriods(data, tz), target), [data, tz, target]);
  const interval = data?.interval ?? "day";
  const recordLabel = isGlobal ? "player game records" : "games";
  const periods = interval === "day" ? "days" : interval === "week" ? "weeks" : "months";
  if (error) return <TrendsRequestError title="Win rate" error={error} retry={mutate} />;
  return (
    <Card title="Win rate" className="min-w-0" right={<span className="rounded-full bg-accent/10 px-2.5 py-1 text-micro font-medium text-accent">{target === "all" ? "All games" : "Recent form"}</span>}>
      {isLoading ? <div role="status" aria-label="Loading Win rate"><Skeleton rows={4} /></div> : !trend.overall.games ? (
        <EmptyState title={isGlobal ? "No player game records match these filters" : "No games match these filters"} sub={isGlobal ? "Adjust the player selection or game filters to broaden this view." : "Adjust the game filters or upload more games to broaden this view."} />
      ) : <>
        <WinRateSampleToggle value={target} onChange={setTarget} />
        <WinRateSampleSummary trend={trend} targetGames={trend.targetGames} interval={interval} recordLabel={recordLabel} />
        <WinRateTrendPlot trend={trend} interval={interval} recordLabel={recordLabel} />
        <div className="mt-3 border-t border-border pt-3 text-caption leading-relaxed text-text-muted">
          {target === "all" ? `Every ${recordLabel.replace(/s$/, "")} in the date range, up to each point. Early points can swing after a single result.` : `At least ${target} ${recordLabel} per point. More games means a steadier view.`}
          <details className="mt-1">
            <summary className="w-fit cursor-pointer rounded py-1 text-micro font-medium text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">How this is calculated</summary>
            <p className="mt-1 text-micro">{target === "all"
              ? `Each point counts every game from the start of the date range through that ${periods.slice(0, -1)}. Wins are divided by all records in that window. Only games within the selected filters and date range are included. The line ends at the overall rate for this range, shown by the dashed line.`
              : `Each point combines the most recent whole ${periods} until the target is reached. Windows can contain more than ${target} games. Wins are divided by all records in that window; larger periods carry more weight. Only games within the selected filters and date range are included. The line starts when the target is reached, and the dashed line shows the overall rate for this range.`}{trend.overall.games > trend.overall.wins + trend.overall.losses ? " Other records have no win/loss result and remain in the total." : ""}{interval !== "day" ? ` This date range uses ${interval === "week" ? "weekly" : "monthly"} records.` : ""}{isGlobal ? " Results combine the selected players; they do not represent an individual player's form." : ""}</p>
          </details>
        </div>
      </>}
    </Card>
  );
}
