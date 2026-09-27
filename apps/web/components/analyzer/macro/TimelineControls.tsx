"use client";

/**
 * The Match timeline's controls and read-out: a segmented metric switch
 * (army, workers, supply, income — each shown with your race's in-game
 * icon — plus APM when the game has it) above the chart, and a
 * "Game time | you | opponent" strip below it that always shows the
 * inspected moment (or the game end), with the leader's margin beside
 * their number.
 */

import { Lock } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { formatGameClock } from "@/lib/macro";
import type { SeriesPoint } from "./activeArmyLayout";
import {
  describeMetric,
  formatSigned,
  metricIcon,
  metricLead,
  timelineMetricsFor,
  type TimelineMetric,
  type TimelineMetricDef,
} from "./timelineMetrics";

/** Beyond this many segments, phones show labels only. */
const PHONE_ICON_SEGMENTS = 4;

/**
 * One rounded track with a sliding highlight behind the chosen metric.
 * Full width on phones (equal segments), sized to its labels from
 * ``sm`` up.
 */
export function MetricSwitch({
  metric,
  onMetric,
  race,
  metrics = timelineMetricsFor({ apm: false }),
}: {
  metric: TimelineMetric;
  onMetric: (next: TimelineMetric) => void;
  /** Your race, for the icons; they are left out when it is unknown. */
  race?: string | null;
  /** The metrics this game can show (APM only with a trusted curve). */
  metrics?: readonly TimelineMetricDef[];
}) {
  const index = Math.max(
    0,
    metrics.findIndex((m) => m.key === metric),
  );
  // The labels need the room on phones once a fifth segment appears,
  // and on the narrowest phones always.
  const iconHide = metrics.length > PHONE_ICON_SEGMENTS ? "max-sm:hidden" : "max-[359px]:hidden";
  return (
    <div
      role="group"
      aria-label="Chart metric"
      className="relative grid rounded-full border border-border bg-bg-subtle p-1 sm:inline-grid"
      style={{ gridTemplateColumns: `repeat(${metrics.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-1 left-1 rounded-full bg-accent shadow-sm transition-transform duration-200"
        style={{
          width: `calc((100% - 0.5rem) / ${metrics.length})`,
          transform: `translateX(${index * 100}%)`,
        }}
      />
      {metrics.map((m) => {
        const on = m.key === metric;
        const icon = metricIcon(m, race);
        const Glyph = icon ? null : m.glyph;
        return (
          <button
            key={m.key}
            type="button"
            aria-pressed={on}
            title={m.title}
            onClick={() => onMetric(m.key)}
            className={`relative flex h-8 min-w-0 items-center justify-center gap-1 rounded-full px-1 text-micro font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent sm:gap-1.5 sm:px-4 sm:text-caption ${
              on ? "text-white" : "text-text-muted hover:text-text"
            }`}
          >
            {icon ? (
              <Icon
                name={icon}
                size={18}
                decorative
                className={`rounded-[3px] ${iconHide} ${on ? "" : "opacity-80"}`}
              />
            ) : Glyph ? (
              <Glyph aria-hidden className={`h-4 w-4 flex-shrink-0 ${iconHide}`} />
            ) : null}
            <span className="truncate">{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function TimelineSummary({
  metric,
  time,
  locked,
  my,
  opp,
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
  myName: string;
  oppName: string;
}) {
  const lead = metricLead(metric, my, opp) ?? 0;
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
  /** How far ahead this player is on the metric, else 0. */
  lead: number;
  tone: string;
}) {
  return (
    <div className="min-w-0 px-3 py-1.5">
      <dt className="truncate text-micro text-text-muted">
        <span className="font-semibold text-text">{name}</span>
        {/* The chosen metric is already on the switch on a phone. */}
        <span className="sr-only sm:not-sr-only sm:whitespace-nowrap"> {caption}</span>
      </dt>
      <dd className={`flex items-baseline gap-1.5 text-h4 font-bold tabular-nums ${tone}`}>
        <span className="truncate">{value}</span>
        {lead > 0 ? (
          <span
            className="text-micro font-semibold"
            title={`${name} leads by ${lead.toLocaleString()}`}
          >
            {formatSigned(lead)}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

