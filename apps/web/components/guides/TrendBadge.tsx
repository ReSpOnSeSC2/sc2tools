import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { fmtDeltaPp, fmtGuideDate, trendDirection, type GuideTrendDirection } from "@/lib/guides/format";
import type { GuideTrend } from "@/lib/guides/types";

const TREND_ICONS = { up: ArrowUp, down: ArrowDown, flat: Minus } as const;
const TREND_TONES = { up: "text-success", down: "text-danger", flat: "text-text-dim" } as const;

function NewTag() {
  return (
    <span className="inline-flex items-center rounded-full border border-accent-cyan/40 px-1.5 text-micro font-bold uppercase text-accent-cyan">
      New
    </span>
  );
}

/**
 * Spoken description of a trend.
 *
 * Example: "Win rate up 1.3 pp since Sep 19, 2026".
 */
function trendLabel(direction: GuideTrendDirection, delta: string, since: string): string {
  if (direction === "flat") return `Win rate flat since ${since}`;
  return `Win rate ${direction} ${delta.replace(/^[+−]/, "")} since ${since}`;
}

/**
 * Week-over-week movement arrow for a win rate, from the payload's
 * `trend.winRateDelta` (current minus the ≥ 7-day-old baseline). New
 * guides show a "New" tag; no trend renders nothing (never a fake 0).
 */
export function TrendBadge({
  trend,
  isNew = false,
  showDelta = false,
}: {
  trend: GuideTrend;
  isNew?: boolean;
  showDelta?: boolean;
}) {
  if (isNew) return <NewTag />;
  if (!trend) return null;
  const direction = trendDirection(trend.winRateDelta);
  const delta = fmtDeltaPp(trend.winRateDelta);
  const label = trendLabel(direction, delta, fmtGuideDate(trend.since));
  const Icon = TREND_ICONS[direction];
  return (
    <span className={`inline-flex items-center gap-0.5 ${TREND_TONES[direction]}`} title={label} data-trend={direction}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      <span className="sr-only">{label}</span>
      {showDelta && direction !== "flat" ? (
        <span aria-hidden className="text-micro tabular-nums">
          {delta}
        </span>
      ) : null}
    </span>
  );
}
