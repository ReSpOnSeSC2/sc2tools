"use client";

import { useId, useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Swords } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import type { StatsEvent } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import {
  buildTimelinePoints,
  detectBattles,
  readoutAt,
  type BattleMarker,
} from "@/lib/gameTimeline";
import { formatGameClock } from "@/lib/macro";

// Design tokens only — the chart must be correct in both themes.
const COLOR_MY_ARMY = "rgb(var(--accent-cyan))";
const COLOR_OPP_ARMY = "rgb(var(--danger))";
const COLOR_MINERALS = "rgb(var(--warning))";
const COLOR_SUPPLY = "rgb(var(--success))";
const COLOR_GRID = "rgb(var(--border))";
const COLOR_AXIS = "rgb(var(--text-dim))";
const COLOR_CURSOR = "rgb(var(--text))";
const COLOR_BATTLE = "rgb(var(--danger))";

export interface InteractiveTimelineProps {
  /** Macro-breakdown sample streams. Either may be missing (older agents). */
  statsEvents?: StatsEvent[] | null;
  oppStatsEvents?: StatsEvent[] | null;
  gameLengthSec?: number | null;
  /** Controlled scrub position (seconds); null = resting at game end. */
  scrubTime: number | null;
  onScrub: (time: number) => void;
  myName?: string | null;
  oppName?: string | null;
  /** Public/share surfaces can replace owner-centric "My" labels. */
  perspectiveLabel?: string | null;
}

/**
 * InteractiveTimeline — army value (mine vs opponent), mineral bank,
 * and supply over game time, with detected fights pinned along the
 * axis. Clicking/tapping the chart, a fight marker, or dragging the
 * scrub slider moves a vertical cursor and updates the "at this
 * moment" readout below (supply, minerals, army values).
 *
 * All the math lives in lib/gameTimeline.ts (pure + unit-tested);
 * this component is rendering and interaction only. No animations —
 * prefers-reduced-motion needs no special casing.
 */
export function InteractiveTimeline({
  statsEvents,
  oppStatsEvents,
  gameLengthSec,
  scrubTime,
  onScrub,
  myName,
  oppName,
  perspectiveLabel,
}: InteractiveTimelineProps) {
  const sliderId = useId();
  const points = useMemo(
    () => buildTimelinePoints(statsEvents, oppStatsEvents),
    [statsEvents, oppStatsEvents],
  );
  const battles = useMemo(
    () => detectBattles(statsEvents, oppStatsEvents),
    [statsEvents, oppStatsEvents],
  );

  const maxT = useMemo(() => {
    const lastSample = points.length ? points[points.length - 1].time : 0;
    return Math.max(
      lastSample,
      typeof gameLengthSec === "number" ? gameLengthSec : 0,
    );
  }, [points, gameLengthSec]);

  const effectiveTime = scrubTime ?? maxT;
  const readout = useMemo(
    () => readoutAt(points, effectiveTime),
    [points, effectiveTime],
  );

  const hasArmy = points.some((p) => p.myArmy !== null || p.oppArmy !== null);
  const hasEconomy = points.some(
    (p) => p.myMinerals !== null || p.mySupply !== null,
  );
  const perspectiveName = perspectiveLabel?.trim() || null;
  const myArmyLabel = perspectiveName
    ? `${possessiveName(perspectiveName)} army`
    : "My army";

  if (points.length === 0) {
    return (
      <Card title="Game timeline">
        <EmptyStatePanel
          size="md"
          title="No timeline samples for this game"
          description="The per-10-second stat stream comes from agent uploads (v0.5+). Open the game's macro breakdown and click Recompute, or resync from the agent, to backfill it."
        />
      </Card>
    );
  }

  const summarySentence = buildSummarySentence(
    maxT,
    battles,
    myName,
    oppName,
    hasArmy,
  );

  return (
    <Card title="Game timeline" data-testid="interactive-timeline">
      <div className="space-y-3">
        <Legend
          hasArmy={hasArmy}
          hasEconomy={hasEconomy}
          myArmyLabel={myArmyLabel}
        />

        <div
          role="img"
          aria-label={summarySentence}
          className="h-64 w-full sm:h-72"
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={points}
              margin={{ top: 8, right: 8, bottom: 4, left: 0 }}
              onClick={(state) => {
                const t = Number(state?.activeLabel);
                if (Number.isFinite(t)) onScrub(t);
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={COLOR_GRID} />
              <XAxis
                type="number"
                dataKey="time"
                domain={[0, maxT]}
                tickFormatter={(v) => formatGameClock(Number(v))}
                stroke={COLOR_AXIS}
                fontSize={11}
                tickMargin={6}
                minTickGap={32}
              />
              <YAxis
                yAxisId="value"
                stroke={COLOR_AXIS}
                fontSize={11}
                width={44}
                tickMargin={4}
                allowDecimals={false}
              />
              <YAxis
                yAxisId="supply"
                orientation="right"
                stroke={COLOR_AXIS}
                fontSize={11}
                width={34}
                tickMargin={4}
                domain={[0, 200]}
                allowDecimals={false}
              />
              <Tooltip
                cursor={{ stroke: COLOR_CURSOR, strokeDasharray: "3 3" }}
                content={({ active, label }) => {
                  if (!active || label == null) return null;
                  const r = readoutAt(points, Number(label));
                  if (!r) return null;
                  return (
                    <div className="rounded-lg border border-border bg-bg-surface px-3 py-2 text-caption shadow-[var(--shadow-card)]">
                      <div className="font-semibold tabular-nums text-text">
                        {formatGameClock(r.time)}
                      </div>
                      <TooltipRow
                        dot={COLOR_MY_ARMY}
                        label={myArmyLabel}
                        value={r.myArmy}
                      />
                      <TooltipRow
                        dot={COLOR_OPP_ARMY}
                        label="Opp army"
                        value={r.oppArmy}
                      />
                      <TooltipRow
                        dot={COLOR_MINERALS}
                        label="Minerals"
                        value={r.myMinerals}
                      />
                      <TooltipRow
                        dot={COLOR_SUPPLY}
                        label="Supply"
                        value={
                          r.mySupply !== null
                            ? `${Math.round(r.mySupply)}${
                                r.mySupplyCap !== null
                                  ? `/${Math.round(r.mySupplyCap)}`
                                  : ""
                              }`
                            : null
                        }
                      />
                    </div>
                  );
                }}
              />
              {battles.map((b) => (
                <ReferenceLine
                  key={`battle-${b.start}`}
                  yAxisId="value"
                  x={b.start}
                  stroke={COLOR_BATTLE}
                  strokeOpacity={0.55}
                  strokeDasharray="4 3"
                />
              ))}
              <ReferenceLine
                yAxisId="value"
                x={Math.min(effectiveTime, maxT)}
                stroke={COLOR_CURSOR}
                strokeWidth={1.5}
              />
              <Line
                yAxisId="value"
                type="monotone"
                dataKey="myArmy"
                name={`${myArmyLabel} value`}
                stroke={COLOR_MY_ARMY}
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
              <Line
                yAxisId="value"
                type="monotone"
                dataKey="oppArmy"
                name="Opponent army value"
                stroke={COLOR_OPP_ARMY}
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
              <Line
                yAxisId="value"
                type="monotone"
                dataKey="myMinerals"
                name="Minerals banked"
                stroke={COLOR_MINERALS}
                strokeWidth={1.5}
                strokeDasharray="5 3"
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
              <Line
                yAxisId="supply"
                type="monotone"
                dataKey="mySupply"
                name="Supply used"
                stroke={COLOR_SUPPLY}
                strokeWidth={1.5}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Keyboard + touch scrubber. Native range input: 44px hit area,
            arrow keys work, no custom motion. */}
        <div className="flex items-center gap-3">
          <label
            htmlFor={sliderId}
            className="whitespace-nowrap text-micro uppercase tracking-wider text-text-dim"
          >
            Scrub
          </label>
          <input
            id={sliderId}
            type="range"
            min={0}
            max={Math.max(1, Math.round(maxT))}
            step={5}
            value={Math.round(Math.min(effectiveTime, maxT))}
            onChange={(e) => onScrub(Number(e.target.value))}
            aria-label="Scrub game time"
            aria-valuetext={formatGameClock(effectiveTime)}
            className="h-11 w-full cursor-pointer accent-[rgb(var(--accent))]"
          />
          <span className="w-12 text-right font-mono text-caption tabular-nums text-text-muted">
            {formatGameClock(effectiveTime)}
          </span>
        </div>

        {battles.length > 0 ? (
          <BattleStrip
            battles={battles}
            onScrub={onScrub}
            perspectiveName={perspectiveName}
          />
        ) : null}

        {readout ? (
          <MomentReadoutBar readout={readout} myArmyLabel={myArmyLabel} />
        ) : null}

        {/* Visually-hidden data summary for screen readers. */}
        <div className="sr-only" data-testid="timeline-sr-summary">
          <p>{summarySentence}</p>
          {battles.length > 0 ? (
            <ul>
              {battles.map((b) => (
                <li key={`sr-battle-${b.start}`}>
                  Fight at {formatGameClock(b.start)}: {perspectiveName || "you"} lost {b.myLoss} army
                  value, opponent lost {b.oppLoss}.
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function TooltipRow({
  dot,
  label,
  value,
}: {
  dot: string;
  label: string;
  value: number | string | null;
}) {
  if (value === null) return null;
  return (
    <div className="flex items-center gap-1.5 text-text-muted">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: dot }}
        aria-hidden
      />
      <span>{label}</span>
      <span className="ml-auto pl-3 font-medium tabular-nums text-text">
        {typeof value === "number" ? Math.round(value) : value}
      </span>
    </div>
  );
}

function Legend({
  hasArmy,
  hasEconomy,
  myArmyLabel,
}: {
  hasArmy: boolean;
  hasEconomy: boolean;
  myArmyLabel: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-text-muted">
      {hasArmy ? (
        <>
          <LegendItem color={COLOR_MY_ARMY} label={`${myArmyLabel} value`} />
          <LegendItem color={COLOR_OPP_ARMY} label="Opponent army value" />
        </>
      ) : null}
      {hasEconomy ? (
        <>
          <LegendItem color={COLOR_MINERALS} label="Minerals banked" dashed />
          <LegendItem color={COLOR_SUPPLY} label="Supply (right axis)" />
        </>
      ) : null}
      <LegendItem color={COLOR_BATTLE} label="Fight detected" dashed />
    </div>
  );
}

function LegendItem({
  color,
  label,
  dashed,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-0.5 w-4 rounded"
        style={{
          background: dashed
            ? `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)`
            : color,
        }}
        aria-hidden
      />
      {label}
    </span>
  );
}

/**
 * Fight markers as real buttons: ≥44px touch targets, keyboard
 * focusable, each scrubs the cursor to the fight's start.
 */
function BattleStrip({
  battles,
  onScrub,
  perspectiveName,
}: {
  battles: BattleMarker[];
  onScrub: (time: number) => void;
  perspectiveName: string | null;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Detected fights"
    >
      {battles.map((b) => (
        <button
          key={`battle-btn-${b.start}`}
          type="button"
          onClick={() => onScrub(b.start)}
          aria-label={`Jump to fight at ${formatGameClock(b.start)} — ${perspectiveName || "you"} lost ${b.myLoss} army value, opponent lost ${b.oppLoss}`}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border bg-bg-elevated px-3 text-caption text-text-muted transition-colors hover:border-border-strong hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Swords className="h-3.5 w-3.5 text-danger" aria-hidden />
          <span className="font-mono tabular-nums text-text">
            {formatGameClock(b.start)}
          </span>
          <span className="tabular-nums">
            −{b.myLoss} <span className="text-text-dim">vs</span> −{b.oppLoss}
          </span>
        </button>
      ))}
    </div>
  );
}

/** "At this moment" readout bar under the chart. */
function MomentReadoutBar({
  readout,
  myArmyLabel,
}: {
  readout: NonNullable<ReturnType<typeof readoutAt>>;
  myArmyLabel: string;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-lg border border-border bg-bg-elevated px-3 py-2"
      data-testid="timeline-readout"
      aria-live="polite"
      role="status"
      aria-label={`At ${formatGameClock(readout.time)}: supply ${
        readout.mySupply !== null ? Math.round(readout.mySupply) : "unknown"
      }${
        readout.mySupplyCap !== null ? ` of ${Math.round(readout.mySupplyCap)}` : ""
      }, minerals ${
        readout.myMinerals !== null ? Math.round(readout.myMinerals) : "unknown"
      }, ${myArmyLabel} ${
        readout.myArmy !== null ? Math.round(readout.myArmy) : "unknown"
      }, opponent army ${
        readout.oppArmy !== null ? Math.round(readout.oppArmy) : "unknown"
      }`}
    >
      <span className="text-micro uppercase tracking-wider text-text-dim">
        At {formatGameClock(readout.time)}
      </span>
      <ReadoutStat
        label="Supply"
        value={
          readout.mySupply !== null
            ? `${Math.round(readout.mySupply)}${
                readout.mySupplyCap !== null
                  ? `/${Math.round(readout.mySupplyCap)}`
                  : ""
              }`
            : "—"
        }
      />
      <ReadoutStat
        label="Minerals"
        value={readout.myMinerals !== null ? Math.round(readout.myMinerals) : "—"}
      />
      <ReadoutStat
        label={myArmyLabel}
        value={readout.myArmy !== null ? Math.round(readout.myArmy) : "—"}
        color={COLOR_MY_ARMY}
      />
      <ReadoutStat
        label="Opp army"
        value={readout.oppArmy !== null ? Math.round(readout.oppArmy) : "—"}
        color={COLOR_OPP_ARMY}
      />
    </div>
  );
}

function possessiveName(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

function ReadoutStat({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5 text-caption text-text-muted">
      {label}
      <span
        className="font-semibold tabular-nums text-text"
        style={color ? { color } : undefined}
      >
        {value}
      </span>
    </span>
  );
}

function buildSummarySentence(
  maxT: number,
  battles: BattleMarker[],
  myName: string | null | undefined,
  oppName: string | null | undefined,
  hasArmy: boolean,
): string {
  const me = (myName || "").trim() || "you";
  const opp = (oppName || "").trim() || "the opponent";
  const base = `Interactive timeline of the ${formatGameClock(maxT)} game between ${me} and ${opp}, charting army value, mineral bank, and supply over time.`;
  if (!hasArmy) {
    return `${base} Army value samples are unavailable for this game.`;
  }
  if (battles.length === 0) return `${base} No major fights were detected.`;
  const clocks = battles.map((b) => formatGameClock(b.start)).join(", ");
  return `${base} ${battles.length} fight${battles.length === 1 ? "" : "s"} detected at ${clocks}.`;
}
