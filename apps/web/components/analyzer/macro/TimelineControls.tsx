"use client";

/**
 * The Match timeline's controls and read-out: a metric switch (army,
 * workers, supply, income — each shown with your race's in-game icon —
 * plus APM when the game has it) above the chart, where any mix of
 * metrics can be on at once and "All" turns every one on or off, and a
 * "Game time | you | opponent" read-out below it that always shows the
 * inspected moment (or the game end). With one metric the read-out puts
 * the leader's margin beside their number; with several it becomes a
 * small table, one column per metric, with the leader's value
 * underlined in their colour.
 */

import { Lock } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { formatApm, type GamePace } from "@/lib/apm";
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

/** Beyond this many segments ("All" included), phones show labels only. */
const PHONE_ICON_SEGMENTS = 4;
/** Wide enough for one full cycle of the longest line pattern. */
const KEY_PX = 22;

const SEGMENT =
  "relative flex h-8 min-w-0 items-center justify-center gap-1 rounded-full px-1 text-micro font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent sm:gap-1.5 sm:px-4 sm:text-caption";
const SEGMENT_ON = "bg-accent text-white shadow-sm";
const SEGMENT_OFF = "text-text-muted hover:bg-bg-elevated hover:text-text";

/**
 * A short sample of a metric's line (its dash pattern) in the current
 * text colour: the legend key on the switch, tooltip and read-out.
 */
export function LineKey({
  dash,
  width = KEY_PX,
  className = "",
}: {
  dash?: string;
  width?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden
      width={width}
      height={4}
      viewBox={`0 0 ${width} 4`}
      className={`flex-shrink-0 overflow-visible ${className}`}
    >
      <line
        x1={1}
        y1={2}
        x2={width - 1}
        y2={2}
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={dash}
      />
    </svg>
  );
}

/**
 * One rounded track of toggles, one per metric, then "All". Any mix can
 * be on; with two or more on, each lit segment also shows its line
 * pattern so the switch doubles as the chart's legend. Full width on
 * phones (equal segments), sized to its labels from ``sm`` up.
 */
export function MetricSwitch({
  selected,
  onChange,
  race,
  metrics = timelineMetricsFor({ apm: false }),
}: {
  /** The metrics currently plotted. */
  selected: readonly TimelineMetric[];
  /** The next selection, always in switch order. */
  onChange: (next: TimelineMetric[]) => void;
  /** Your race, for the icons; they are left out when it is unknown. */
  race?: string | null;
  /** The metrics this game can show (APM only with a trusted curve). */
  metrics?: readonly TimelineMetricDef[];
}) {
  const on = new Set(selected);
  const allOn = metrics.every((m) => on.has(m.key));
  const keyed = metrics.filter((m) => on.has(m.key)).length > 1;
  // The labels need the room on phones once a fifth segment appears,
  // and on the narrowest phones always.
  const iconHide =
    metrics.length + 1 > PHONE_ICON_SEGMENTS ? "max-sm:hidden" : "max-[359px]:hidden";
  const inOrder = (keys: Set<TimelineMetric>) =>
    metrics.filter((m) => keys.has(m.key)).map((m) => m.key);
  const toggle = (key: TimelineMetric) => {
    const next = new Set(on);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(inOrder(next));
  };
  return (
    <div
      role="group"
      aria-label="Chart metrics"
      className="grid gap-0.5 rounded-full border border-border bg-bg-subtle p-1 sm:inline-grid"
      style={{ gridTemplateColumns: `repeat(${metrics.length}, minmax(0, 1fr)) auto` }}
    >
      {metrics.map((m) => {
        const pressed = on.has(m.key);
        const icon = metricIcon(m, race);
        const Glyph = icon ? null : m.glyph;
        return (
          <button
            key={m.key}
            type="button"
            aria-pressed={pressed}
            title={m.title}
            onClick={() => toggle(m.key)}
            className={`${SEGMENT} ${pressed ? SEGMENT_ON : SEGMENT_OFF}`}
          >
            {icon ? (
              <Icon
                name={icon}
                size={18}
                decorative
                className={`rounded-[3px] ${iconHide} ${pressed ? "" : "opacity-80"}`}
              />
            ) : Glyph ? (
              <Glyph aria-hidden className={`h-4 w-4 flex-shrink-0 ${iconHide}`} />
            ) : null}
            <span className="truncate">{m.label}</span>
            {pressed && keyed ? (
              // Under the label on phones, beside it from ``sm`` up.
              <LineKey
                dash={m.dash}
                className="absolute bottom-[3px] left-1/2 -translate-x-1/2 sm:static sm:translate-x-0"
              />
            ) : null}
          </button>
        );
      })}
      <button
        type="button"
        aria-pressed={allOn}
        title={allOn ? "Clear every metric" : "Plot every metric"}
        onClick={() => onChange(allOn ? [] : metrics.map((m) => m.key))}
        className={`${SEGMENT} ml-0.5 !px-2.5 before:pointer-events-none before:absolute before:-left-[3px] before:inset-y-1.5 before:w-px before:bg-border before:content-[''] sm:!px-3.5 ${
          allOn ? SEGMENT_ON : SEGMENT_OFF
        }`}
      >
        All
      </button>
    </div>
  );
}

/** "Game time" with the lock badge once a tap or click has pinned it. */
function GameTimeLabel({ locked, compact = false }: { locked: boolean; compact?: boolean }) {
  return (
    <span className="flex items-center gap-1 whitespace-nowrap text-micro text-text-muted">
      <span className={compact ? "sr-only sm:not-sr-only" : undefined}>Game time</span>
      {locked ? (
        <span
          className="inline-flex items-center gap-0.5 text-accent-cyan"
          title="Locked while you scroll. Tap or click another spot on the chart to move it, or anywhere else to release it."
        >
          <Lock className="h-3 w-3" aria-hidden />
          <span className="sr-only sm:not-sr-only">locked</span>
        </span>
      ) : null}
    </span>
  );
}

export function TimelineSummary({
  metrics,
  time,
  locked,
  my,
  opp,
  myName,
  oppName,
  averages = null,
}: {
  /** The plotted metrics, in switch order (may be empty). */
  metrics: readonly TimelineMetricDef[];
  /** The clock the values belong to. */
  time: number;
  /** A tap or click has pinned this moment. */
  locked: boolean;
  my: SeriesPoint | null;
  opp: SeriesPoint | null;
  myName: string;
  oppName: string;
  /** Whole-game pace per player, shown as a second row (the APM view). */
  averages?: { my: GamePace | null; opp: GamePace | null } | null;
}) {
  if (metrics.length !== 1) {
    return (
      <MetricTable
        metrics={metrics}
        time={time}
        locked={locked}
        my={my}
        opp={opp}
        myName={myName}
        oppName={oppName}
      />
    );
  }
  const metric = metrics[0];
  const lead = metricLead(metric, my, opp) ?? 0;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] border-y border-border">
      <div className="px-3 py-1.5">
        <dt>
          <GameTimeLabel locked={locked} />
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
      {averages && metric.key === "apm" ? (
        <>
          <div className="border-t border-border px-3 py-1">
            <dt
              className="whitespace-nowrap text-micro text-text-muted"
              title="Actions and selections per minute over the time each player was in the game"
            >
              Game average
            </dt>
            <dd className="sr-only">APM and SPM over the whole game</dd>
          </div>
          <PaceCell name={myName} pace={averages.my} />
          <PaceCell name={oppName} pace={averages.opp} />
        </>
      ) : null}
    </dl>
  );
}

/** One player's game-average APM and SPM; wraps onto two lines on a phone. */
function PaceCell({ name, pace }: { name: string; pace: GamePace | null }) {
  return (
    <div className="min-w-0 border-l border-t border-border px-3 py-1">
      <dt className="sr-only">{name}</dt>
      <dd className="flex flex-wrap items-baseline gap-x-2 text-caption tabular-nums text-text-muted">
        <span className="whitespace-nowrap">
          <span className="font-semibold text-text">{formatApm(pace?.apm)}</span> APM
        </span>
        <span className="whitespace-nowrap">
          <span className="font-semibold text-text">{formatApm(pace?.spm)}</span> SPM
        </span>
      </dd>
    </div>
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
    <div className="min-w-0 border-l border-border px-3 py-1.5">
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


/**
 * The read-out with several metrics on (or none): the moment, then one
 * column per metric with both players' values. The leader's value is
 * underlined in their colour; the tooltip carries the exact margin.
 */
function MetricTable({
  metrics,
  time,
  locked,
  my,
  opp,
  myName,
  oppName,
}: {
  metrics: readonly TimelineMetricDef[];
  time: number;
  locked: boolean;
  my: SeriesPoint | null;
  opp: SeriesPoint | null;
  myName: string;
  oppName: string;
}) {
  if (metrics.length === 0) {
    return (
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center border-y border-border">
        <div className="px-3 py-1.5">
          <dt>
            <GameTimeLabel locked={locked} />
          </dt>
          <dd className="text-h4 font-bold tabular-nums text-text">{formatGameClock(time)}</dd>
        </div>
        <dd className="border-l border-border px-3 py-3 text-caption text-text-muted">
          No metric selected
        </dd>
      </dl>
    );
  }
  // Five columns on a phone need the smaller numbers to fit "120/130".
  const valueSize = metrics.length > 3 ? "text-micro sm:text-caption" : "text-caption";
  const leads = metrics.map((m) => metricLead(m, my, opp) ?? 0);
  return (
    <table className="w-full table-fixed border-y border-border text-left">
      <caption className="sr-only">
        {`${metrics.map((m) => m.title).join(", ")} for both players at ${formatGameClock(time)}`}
      </caption>
      <thead>
        <tr>
          <th
            scope="col"
            className={`${metrics.length > 3 ? "w-16" : "w-24"} px-3 pb-0.5 pt-1.5 align-bottom font-normal sm:w-40`}
          >
            <GameTimeLabel locked={locked} compact />
            <span className="block text-caption font-bold tabular-nums text-text">
              {formatGameClock(time)}
            </span>
          </th>
          {metrics.map((m) => (
            <th
              key={m.key}
              scope="col"
              title={m.title}
              className="border-l border-border px-1 pb-0.5 pt-1.5 align-bottom text-micro font-semibold text-text-muted sm:px-3"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <LineKey
                  dash={m.dash}
                  className={metrics.length > 3 ? "max-sm:hidden" : "max-[389px]:hidden"}
                />
                <span className="truncate">{m.label}</span>
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(["my", "opp"] as const).map((side) => (
          <tr key={side}>
            <th scope="row" className="min-w-0 px-3 py-0.5 text-micro font-semibold text-text">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden
                  className={`h-2 w-2 flex-shrink-0 rounded-full ${side === "my" ? "bg-player-you" : "bg-player-opp"}`}
                />
                <span className="truncate">{side === "my" ? myName : oppName}</span>
              </span>
            </th>
            {metrics.map((m, i) => {
              const value = describeMetric(m, side === "my" ? my : opp);
              const ahead = side === "my" ? leads[i] > 0 : leads[i] < 0;
              return (
                <td
                  key={m.key}
                  className={`truncate border-l border-border px-1 py-0.5 font-bold tabular-nums text-text sm:px-3 ${valueSize}`}
                  title={value}
                >
                  <span
                    className={
                      ahead
                        ? `underline decoration-2 underline-offset-[3px] ${side === "my" ? "decoration-player-you" : "decoration-player-opp"}`
                        : undefined
                    }
                  >
                    {value}
                  </span>
                  {ahead ? <span className="sr-only"> (ahead)</span> : null}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
