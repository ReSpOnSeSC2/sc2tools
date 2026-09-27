"use client";

/**
 * The Match timeline's controls and read-out, in sc2replaystats'
 * arrangement: a row of metric buttons plus the "Supply Blocks"
 * toggle above the chart, and a "Game time | you | opponent" strip
 * below it that always shows the inspected moment (or the game end).
 */

import { Lock } from "lucide-react";
import { formatGameClock } from "@/lib/macro";
import type { SeriesPoint } from "./activeArmyLayout";
import {
  TIMELINE_METRICS,
  describeMetric,
  formatSigned,
  type AdvantagePoint,
  type TimelineMetric,
  type TimelineMetricDef,
} from "./timelineMetrics";

// Phones: equal cells in a 3 x 2 grid, labels allowed to wrap on the
// narrowest screens. From sm up: a single wrapping row of buttons.
const SEGMENT_BASE =
  "inline-flex min-h-8 items-center justify-center rounded-md border px-1.5 py-1 text-center text-micro font-semibold leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40 sm:h-8 sm:flex-shrink-0 sm:whitespace-nowrap sm:px-2.5 sm:py-0 sm:text-caption";
const SEGMENT_ON = "border-text bg-text text-bg";
const SEGMENT_OFF =
  "border-border bg-bg-surface text-text-muted hover:bg-bg-elevated hover:text-text";

export function MetricTabs({
  metric,
  onMetric,
  showBlocks,
  onToggleBlocks,
  blocksAvailable,
}: {
  metric: TimelineMetric;
  onMetric: (next: TimelineMetric) => void;
  showBlocks: boolean;
  onToggleBlocks: () => void;
  /** False when neither player has a recorded supply block. */
  blocksAvailable: boolean;
}) {
  return (
    // Every option visible on a phone (no swiping to find Supply Blocks),
    // in two compact rows like sc2replaystats.
    <div
      role="group"
      aria-label="Chart view"
      className="grid grid-cols-3 gap-1.5 sm:flex sm:flex-wrap sm:items-center"
    >
      {TIMELINE_METRICS.map((m) => {
        const on = m.key === metric;
        return (
          <button
            key={m.key}
            type="button"
            aria-pressed={on}
            onClick={() => onMetric(m.key)}
            className={`${SEGMENT_BASE} ${on ? SEGMENT_ON : SEGMENT_OFF}`}
          >
            {m.label}
          </button>
        );
      })}
      <button
        type="button"
        aria-pressed={blocksAvailable && showBlocks}
        disabled={!blocksAvailable}
        onClick={onToggleBlocks}
        title={blocksAvailable ? undefined : "No supply blocks in this game"}
        className={`${SEGMENT_BASE} ${blocksAvailable && showBlocks ? SEGMENT_ON : SEGMENT_OFF}`}
      >
        Supply Blocks
      </button>
    </div>
  );
}

export function TimelineSummary({
  metric,
  time,
  locked,
  my,
  opp,
  advantage,
  myName,
  oppName,
}: {
  metric: TimelineMetricDef;
  /** The clock the values belong to. */
  time: number;
  /** A tap or click has pinned this moment. */
  locked: boolean;
  my: SeriesPoint | null;
  opp: SeriesPoint | null;
  advantage: AdvantagePoint | null;
  myName: string;
  oppName: string;
}) {
  const lead = metric.advantage && advantage ? Math.round(advantage.value) : 0;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] divide-x divide-border border-y border-border">
      <div className="px-3 py-1.5">
        <dt className="flex items-center gap-1 whitespace-nowrap text-micro text-text-muted">
          Game time
          {locked ? (
            <span
              className="inline-flex items-center gap-0.5 text-accent-cyan"
              title="Locked while you scroll. Tap or click another spot on the chart to move it."
            >
              <Lock className="h-3 w-3" aria-hidden />
              <span className="sr-only sm:not-sr-only">locked</span>
            </span>
          ) : null}
        </dt>
        <dd className="text-h4 font-bold tabular-nums text-text">
          {formatGameClock(time)}
        </dd>
      </div>
      <PlayerCell
        name={myName}
        caption={metric.caption}
        value={describeMetric(metric, my)}
        lead={lead > 0 ? lead : 0}
        tone="text-player-you"
      />
      <PlayerCell
        name={oppName}
        caption={metric.caption}
        value={describeMetric(metric, opp)}
        lead={lead < 0 ? -lead : 0}
        tone="text-player-opp"
      />
    </dl>
  );
}

function PlayerCell({
  name,
  caption,
  value,
  lead,
  tone,
}: {
  name: string;
  caption: string;
  value: string;
  /** How far ahead this player is (advantage metrics), else 0. */
  lead: number;
  tone: string;
}) {
  return (
    <div className="min-w-0 px-3 py-1.5">
      <dt className="truncate text-micro text-text-muted">
        <span className="font-semibold text-text">{name}</span>
        {/* The pressed tab already names the metric on a phone. */}
        <span className="sr-only sm:not-sr-only sm:whitespace-nowrap"> {caption}</span>
      </dt>
      <dd className={`flex items-baseline gap-1.5 text-h4 font-bold tabular-nums ${tone}`}>
        <span className="truncate">{value}</span>
        {lead > 0 ? (
          <span className="text-micro font-semibold">{formatSigned(lead)}</span>
        ) : null}
      </dd>
    </div>
  );
}
