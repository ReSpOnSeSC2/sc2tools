import { TrendingDown, TrendingUp } from "lucide-react";

import { localDateKey } from "@/lib/timeseries";
import type {
  DailyMmrRegionSwings,
  DailyMmrSwing,
  DailyMmrSwings,
} from "@/lib/netMmrOpponents";

type Props = {
  dailySwings?: DailyMmrSwings;
  isLoading?: boolean;
  unavailable?: boolean;
};

/**
 * Format the API's timezone-aware day without parsing a bare YYYY-MM-DD key.
 * Formatting the bucket instant in the same timezone that produced it avoids
 * shifting the label back a day for users west of UTC.
 */
export function formatDailySwingDate(
  day: string,
  timeZone: string,
  locale?: string,
): string {
  const instant = new Date(day);
  if (Number.isNaN(instant.getTime())) return "Unknown date";
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(instant);
  } catch {
    return localDateKey(instant, "UTC") || "Unknown date";
  }
}

/** Compact daily records that live directly beneath MMR progression. */
export function MmrDailySwings({
  dailySwings,
  isLoading = false,
  unavailable = false,
}: Props) {
  const regions = Array.isArray(dailySwings?.regions)
    ? dailySwings.regions
    : [];
  const multipleRegions = regions.length > 1;
  // A one-region response is equivalent to the aggregate, but using the
  // region row protects against a stale/mixed aggregate during cache rollout.
  const primary = regions.length === 1 ? regions[0] : dailySwings;
  const primaryRegion = regions.length === 1
    ? ownRegionLabel(regions[0].region)
    : null;
  const summary = regions.length === 1 ? regions[0] : dailySwings;

  return (
    <section
      aria-label="Daily MMR records"
      className="mt-3 border-t border-border pt-3"
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div>
          <h4 className="text-caption font-semibold text-text">
            Daily MMR records
          </h4>
          <p className="text-micro text-text-dim">
            Verified net change from consecutive synced ranked 1v1 replay
            readings, grouped by your local day
            {multipleRegions
              ? ". Records stay separate by your Battle.net region; opponent-region and all other selected filters still apply."
              : " across the selected ladders."}
          </p>
        </div>
        {summary && summary.measuredGames > 0 ? (
          <p className="text-micro tabular-nums text-text-dim">
            {primaryRegion ? `${primaryRegion} · ` : ""}
            {summary.measuredGames.toLocaleString()} measured{" "}
            {summary.measuredGames === 1 ? "game" : "games"}
            {summary.measuredDays > 0
              ? ` across ${summary.measuredDays.toLocaleString()} ${summary.measuredDays === 1 ? "day" : "days"}`
              : ""}
          </p>
        ) : null}
      </div>

      {isLoading ? (
        <div
          aria-label="Loading daily MMR records"
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          <DailySwingSkeleton />
          <DailySwingSkeleton />
        </div>
      ) : unavailable || !dailySwings ? (
        <div
          role="status"
          className="rounded-lg bg-bg-elevated/45 px-3 py-2 text-xs text-text-dim"
        >
          Daily MMR records are temporarily unavailable. Your progression chart
          is unaffected.
        </div>
      ) : multipleRegions ? (
        <div className="space-y-2" aria-label="MMR records by your Battle.net region">
          {regions.map((region) => (
            <RegionDailySwings
              key={region.region}
              region={region}
              timeZone={dailySwings.timezone}
            />
          ))}
        </div>
      ) : primary ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <DailySwingTile
            kind="gain"
            swing={primary.bestGain}
            timeZone={dailySwings.timezone}
            hasMeasuredDays={primary.measuredDays > 0}
          />
          <DailySwingTile
            kind="loss"
            swing={primary.biggestLoss}
            timeZone={dailySwings.timezone}
            hasMeasuredDays={primary.measuredDays > 0}
          />
        </div>
      ) : null}
    </section>
  );
}

function RegionDailySwings({
  region,
  timeZone,
}: {
  region: DailyMmrRegionSwings;
  timeZone: string;
}) {
  const label = ownRegionLabel(region.region);
  return (
    <article
      aria-label={`${label} daily MMR records`}
      className="overflow-hidden rounded-lg border border-border bg-bg-elevated/45"
    >
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-b border-border px-3 py-2">
        <div className="flex items-baseline gap-2">
          <h5 className="text-caption font-semibold text-text">{label}</h5>
          <span className="text-micro text-text-dim">Battle.net region</span>
        </div>
        <span className="text-micro tabular-nums text-text-dim">
          {region.measuredGames.toLocaleString()} measured{" "}
          {region.measuredGames === 1 ? "game" : "games"}
          {region.measuredDays > 0
            ? ` · ${region.measuredDays.toLocaleString()} ${region.measuredDays === 1 ? "day" : "days"}`
            : ""}
        </span>
      </header>
      <div className="grid grid-cols-2 divide-x divide-border">
        <RegionalSwingMetric
          kind="gain"
          swing={region.bestGain}
          timeZone={timeZone}
          hasMeasuredDays={region.measuredDays > 0}
        />
        <RegionalSwingMetric
          kind="loss"
          swing={region.biggestLoss}
          timeZone={timeZone}
          hasMeasuredDays={region.measuredDays > 0}
        />
      </div>
    </article>
  );
}

function RegionalSwingMetric({
  kind,
  swing,
  timeZone,
  hasMeasuredDays,
}: {
  kind: "gain" | "loss";
  swing: DailyMmrSwing | null;
  timeZone: string;
  hasMeasuredDays: boolean;
}) {
  const gain = kind === "gain";
  const Icon = gain ? TrendingUp : TrendingDown;
  return (
    <div className="min-w-0 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-micro font-semibold uppercase tracking-wider text-text-dim">
        <Icon
          aria-hidden
          className={`h-3.5 w-3.5 shrink-0 ${gain ? "text-success" : "text-danger"}`}
        />
        <span>{gain ? "Highest gain day" : "Biggest loss day"}</span>
      </div>
      {swing ? (
        <>
          <p
            className={`mt-0.5 text-base font-bold tabular-nums ${gain ? "text-success" : "text-danger"}`}
          >
            {formatSignedMmr(swing.netMmr)} MMR
          </p>
          <SwingContext swing={swing} timeZone={timeZone} compact />
        </>
      ) : (
        <>
          <p className="mt-1 text-xs font-semibold text-text-muted">
            No measured {gain ? "gain" : "loss"}
          </p>
          <p className="text-micro text-text-dim">
            {hasMeasuredDays
              ? `No day ${gain ? "above" : "below"} 0 MMR.`
              : "No verified changes."}
          </p>
        </>
      )}
    </div>
  );
}

function ownRegionLabel(region: DailyMmrRegionSwings["region"]): string {
  return region === "U" ? "Unknown region" : region;
}

function SwingContext({
  swing,
  timeZone,
  compact = false,
}: {
  swing: DailyMmrSwing;
  timeZone: string;
  compact?: boolean;
}) {
  return (
    <p
      className={`${compact ? "mt-0.5" : ""} text-micro leading-4 tabular-nums text-text-dim`}
    >
      <span>{formatDailySwingDate(swing.day, timeZone)}</span>
      <span aria-hidden> · </span>
      <span>
        {swing.measuredGames.toLocaleString()} measured{" "}
        {swing.measuredGames === 1 ? "game" : "games"}
      </span>
      <span aria-hidden> · </span>
      <span>
        <span aria-hidden>
          {swing.wins.toLocaleString()}–{swing.losses.toLocaleString()}
        </span>
        <span className="sr-only">
          {swing.wins.toLocaleString()} {swing.wins === 1 ? "win" : "wins"},{" "}
          {swing.losses.toLocaleString()} {swing.losses === 1 ? "loss" : "losses"}
        </span>
      </span>
    </p>
  );
}

function DailySwingTile({
  kind,
  swing,
  timeZone,
  hasMeasuredDays,
}: {
  kind: "gain" | "loss";
  swing: DailyMmrSwing | null;
  timeZone: string;
  hasMeasuredDays: boolean;
}) {
  const gain = kind === "gain";
  const Icon = gain ? TrendingUp : TrendingDown;
  const label = gain ? "Highest MMR gain day" : "Biggest MMR loss day";
  const tone = gain ? "text-success" : "text-danger";
  const iconTone = gain
    ? "bg-success/15 text-success"
    : "bg-danger/15 text-danger";

  return (
    <article className="flex min-h-[84px] items-center gap-3 rounded-lg border border-border bg-bg-elevated/45 px-3 py-2.5">
      <span
        aria-hidden
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${iconTone}`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <h5 className="text-micro font-semibold uppercase tracking-wider text-text-dim">
          {label}
        </h5>
        {swing ? (
          <>
            <p className={`text-lg font-bold tabular-nums ${tone}`}>
              {formatSignedMmr(swing.netMmr)} MMR
            </p>
            <SwingContext swing={swing} timeZone={timeZone} />
          </>
        ) : (
          <>
            <p className="text-sm font-semibold text-text-muted">
              No measured {gain ? "gain" : "loss"}
            </p>
            <p className="text-micro text-text-dim">
              {hasMeasuredDays
                ? `No day finished ${gain ? "above" : "below"} 0 MMR in this view.`
                : "No verified daily changes in this view."}
            </p>
          </>
        )}
      </div>
    </article>
  );
}

function DailySwingSkeleton() {
  return (
    <div className="flex min-h-[84px] animate-pulse items-center gap-3 rounded-lg border border-border bg-bg-elevated/45 px-3 py-2.5">
      <div className="h-9 w-9 shrink-0 rounded-lg bg-bg-subtle" />
      <div className="flex-1 space-y-2">
        <div className="h-3 w-24 rounded bg-bg-subtle" />
        <div className="h-4 w-16 rounded bg-bg-subtle" />
        <div className="h-3 w-36 max-w-full rounded bg-bg-subtle" />
      </div>
    </div>
  );
}

function formatSignedMmr(value: number): string {
  if (value > 0) return `+${value.toLocaleString()}`;
  if (value < 0) return `−${Math.abs(value).toLocaleString()}`;
  return "0";
}
