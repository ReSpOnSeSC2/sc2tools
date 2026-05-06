"use client";

import { useId, useMemo } from "react";
import { AlertCircle } from "lucide-react";
import type { StatsEvent } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import { formatGameClock } from "@/lib/macro";

/**
 * ResourcesOverTimeChart — three lines per player on a shared time axis.
 *
 *   - Income       = minerals_collection_rate + vespene_collection_rate
 *   - Unspent      = minerals_current + vespene_current
 *   - In progress  = minerals_used_in_progress + vespene_used_in_progress
 *
 * Style encodes ownership (dotted = you, solid = opponent). Each series
 * has its own colour. A translucent green polygon overlays the income
 * "good band" — 60-80 minerals per worker per minute against the user's
 * worker count over time.
 *
 * Empty stats_events (older replays whose tracker stream had no
 * PlayerStatsEvent rows) → renders an inline empty-state. Never
 * synthesises values.
 *
 * Pure SVG so the chart sits next to ActiveArmyChart with matching look
 * and feel (no extra chart library, no canvas).
 */

export interface ResourcesOverTimeChartProps {
  samples: StatsEvent[];
  oppSamples: StatsEvent[];
  gameLengthSec?: number;
}

const VIEW_W = 720;
const VIEW_H = 240;
const PAD_LEFT = 56;
const PAD_RIGHT = 56;
const PAD_TOP = 14;
const PAD_BOTTOM = 30;
const X_TICK_STEP_SEC = 60;
const LINE_OPACITY = 0.95;
const BAND_OPACITY = 0.18;
const INCOME_PER_WORKER_LOW = 60;
const INCOME_PER_WORKER_HIGH = 80;

const COLOR_AXIS = "rgb(var(--text-dim))";
const COLOR_GRID = "rgb(var(--border))";
const COLOR_INCOME = "rgb(var(--success))";
const COLOR_UNSPENT = "rgb(var(--warning))";
const COLOR_PROGRESS = "rgb(var(--accent-cyan))";
const COLOR_BAND = "rgb(var(--success))";

interface Series {
  time: number[];
  income: number[];
  unspent: number[];
  in_progress: number[];
  workers: number[];
}

const SERIES_COLOR: Record<keyof Omit<Series, "time" | "workers">, string> = {
  income: COLOR_INCOME,
  unspent: COLOR_UNSPENT,
  in_progress: COLOR_PROGRESS,
};

const SERIES_LABEL: Record<keyof Omit<Series, "time" | "workers">, string> = {
  income: "Income",
  unspent: "Unspent",
  in_progress: "In progress",
};

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function buildSeries(samples: StatsEvent[]): Series | null {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  return {
    time: samples.map((s) => num(s.time)),
    income: samples.map(
      (s) => num(s.minerals_collection_rate) + num(s.vespene_collection_rate),
    ),
    unspent: samples.map(
      (s) => num(s.minerals_current) + num(s.vespene_current),
    ),
    in_progress: samples.map(
      (s) =>
        num(s.minerals_used_in_progress) + num(s.vespene_used_in_progress),
    ),
    workers: samples.map((s) => num(s.food_workers)),
  };
}

function yAxisCeiling(seriesList: Array<Series | null>): number {
  let m = 0;
  for (const s of seriesList) {
    if (!s) continue;
    for (const arr of [s.income, s.unspent, s.in_progress]) {
      for (const v of arr) if (v > m) m = v;
    }
    for (const w of s.workers) {
      const ceiling = w * INCOME_PER_WORKER_HIGH;
      if (ceiling > m) m = ceiling;
    }
  }
  if (m <= 0) return 1000;
  const steps = [500, 1000, 1500, 2000, 3000, 4000, 5000, 7500, 10000];
  for (const step of steps) if (m <= step) return step;
  return Math.ceil(m / 1000) * 1000;
}

function xAxisCeiling(
  seriesList: Array<Series | null>,
  gameLengthSec?: number,
): number {
  let m = 0;
  for (const s of seriesList) {
    if (!s || s.time.length === 0) continue;
    const last = s.time[s.time.length - 1];
    if (last > m) m = last;
  }
  if (gameLengthSec && gameLengthSec > m) m = gameLengthSec;
  return Math.max(60, m);
}

function pathFor(
  times: number[],
  values: number[],
  plotW: number,
  plotH: number,
  xMax: number,
  yMax: number,
): string {
  if (!values || values.length === 0 || yMax <= 0 || xMax <= 0) return "";
  const xAt = (t: number) => PAD_LEFT + (t / xMax) * plotW;
  const yAt = (v: number) =>
    PAD_TOP + plotH - (Math.min(v, yMax) / yMax) * plotH;
  let d = "";
  for (let i = 0; i < values.length; i += 1) {
    d +=
      (i === 0 ? "M " : " L ") +
      xAt(times[i]).toFixed(2) +
      " " +
      yAt(values[i]).toFixed(2);
  }
  return d;
}

function bandPolygon(
  times: number[],
  workers: number[],
  plotW: number,
  plotH: number,
  xMax: number,
  yMax: number,
): string {
  if (!workers || workers.length === 0) return "";
  const xAt = (t: number) => PAD_LEFT + (t / xMax) * plotW;
  const yAt = (v: number) =>
    PAD_TOP + plotH - (Math.min(v, yMax) / yMax) * plotH;
  let upper = "";
  for (let i = 0; i < workers.length; i += 1) {
    upper +=
      (i === 0 ? "M " : " L ") +
      xAt(times[i]).toFixed(2) +
      " " +
      yAt(workers[i] * INCOME_PER_WORKER_HIGH).toFixed(2);
  }
  let lower = "";
  for (let i = workers.length - 1; i >= 0; i -= 1) {
    lower +=
      " L " +
      xAt(times[i]).toFixed(2) +
      " " +
      yAt(workers[i] * INCOME_PER_WORKER_LOW).toFixed(2);
  }
  return upper + lower + " Z";
}

export function ResourcesOverTimeChart({
  samples,
  oppSamples,
  gameLengthSec,
}: ResourcesOverTimeChartProps) {
  const chartId = useId();
  const layout = useMemo(() => {
    const my = buildSeries(samples);
    const opp = buildSeries(oppSamples);
    if (!my && !opp) return null;
    const xMax = xAxisCeiling([my, opp], gameLengthSec);
    const yMax = yAxisCeiling([my, opp]);
    const plotW = VIEW_W - PAD_LEFT - PAD_RIGHT;
    const plotH = VIEW_H - PAD_TOP - PAD_BOTTOM;
    const xTicks: number[] = [];
    for (let t = 0; t <= xMax; t += X_TICK_STEP_SEC) xTicks.push(t);
    return { my, opp, xMax, yMax, plotW, plotH, xTicks };
  }, [samples, oppSamples, gameLengthSec]);

  if (!layout) return <ChartEmptyState />;

  const yTickFracs = [0, 0.25, 0.5, 0.75, 1];
  const seriesKeys = ["income", "unspent", "in_progress"] as const;
  const bandSource = layout.my || layout.opp;
  const bandPath = bandSource
    ? bandPolygon(
        bandSource.time,
        bandSource.workers,
        layout.plotW,
        layout.plotH,
        layout.xMax,
        layout.yMax,
      )
    : "";

  const renderPaths = (series: Series | null, dasharray: string) => {
    if (!series) return null;
    return seriesKeys.map((k) => {
      const d = pathFor(
        series.time,
        series[k],
        layout.plotW,
        layout.plotH,
        layout.xMax,
        layout.yMax,
      );
      if (!d) return null;
      return (
        <path
          key={k}
          d={d}
          fill="none"
          stroke={SERIES_COLOR[k]}
          strokeWidth="1.6"
          strokeDasharray={dasharray}
          opacity={LINE_OPACITY}
        />
      );
    });
  };

  return (
    <figure className="space-y-2" aria-labelledby={`${chartId}-title`}>
      <figcaption
        id={`${chartId}-title`}
        className="flex flex-wrap items-center justify-between gap-2 text-caption text-text-muted"
      >
        <span className="font-semibold uppercase tracking-wider text-text">
          Resources over time
        </span>
        <Legend />
      </figcaption>

      <div className="overflow-x-auto rounded-lg border border-border bg-bg-elevated">
        <svg
          role="img"
          aria-label="Income, unspent bank, and in-progress costs over game time, both players overlaid"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="block h-[240px] w-full min-w-[480px]"
        >
          {bandPath ? (
            <path d={bandPath} fill={COLOR_BAND} opacity={BAND_OPACITY} />
          ) : null}
          {yTickFracs.map((frac, i) => {
            const y = PAD_TOP + layout.plotH - frac * layout.plotH;
            const v = Math.round(layout.yMax * frac);
            return (
              <g key={`y-${i}`}>
                <line
                  x1={PAD_LEFT}
                  y1={y}
                  x2={VIEW_W - PAD_RIGHT}
                  y2={y}
                  stroke={COLOR_GRID}
                  strokeDasharray="2 4"
                />
                <text
                  x={PAD_LEFT - 6}
                  y={y + 3}
                  textAnchor="end"
                  fontSize="10"
                  fill={COLOR_AXIS}
                >
                  {v}
                </text>
              </g>
            );
          })}
          {layout.xTicks.map((t, i) => {
            const x =
              PAD_LEFT +
              (layout.xMax > 0 ? (t / layout.xMax) * layout.plotW : 0);
            return (
              <g key={`x-${i}`}>
                <line
                  x1={x}
                  y1={PAD_TOP + layout.plotH}
                  x2={x}
                  y2={PAD_TOP + layout.plotH + 4}
                  stroke={COLOR_AXIS}
                  strokeOpacity="0.6"
                />
                <text
                  x={x}
                  y={VIEW_H - 12}
                  textAnchor="middle"
                  fontSize="10"
                  fill={COLOR_AXIS}
                >
                  {formatGameClock(t)}
                </text>
              </g>
            );
          })}
          <text
            x={VIEW_W - PAD_RIGHT + 6}
            y={PAD_TOP + 10}
            fontSize="10"
            fill={COLOR_BAND}
            opacity="0.85"
          >
            good band
          </text>
          <text
            x={VIEW_W - PAD_RIGHT + 6}
            y={PAD_TOP + 22}
            fontSize="9"
            fill={COLOR_AXIS}
          >
            {INCOME_PER_WORKER_LOW}-{INCOME_PER_WORKER_HIGH}/wkr
          </text>
          {renderPaths(layout.my, "3 3")}
          {renderPaths(layout.opp, "0")}
        </svg>
      </div>

      <p className="px-1 text-caption text-text-dim">
        Income = minerals + vespene per minute. Unspent = current bank.
        In&nbsp;progress = mineral+gas cost of units, buildings, and upgrades
        still under construction. Green band = the 60-80 mineral/worker/minute
        rate you should be hitting given your worker count.
      </p>
    </figure>
  );
}

function ChartEmptyState() {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-bg-subtle p-4">
      <div className="inline-flex items-center gap-2 text-caption font-semibold text-accent-cyan">
        <AlertCircle className="h-4 w-4" aria-hidden />
        Resources samples unavailable
      </div>
      <p className="text-caption text-text-muted">
        This replay has no PlayerStatsEvent rows in its tracker stream — older
        replays drop them, and our slim breakdown excludes them by default.
        Trigger a recompute to fetch the full sample stream from your SC2
        agent.
      </p>
    </div>
  );
}

function Legend() {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
      <LegendSwatch color={COLOR_INCOME} dashed label={SERIES_LABEL.income} suffix="(you)" />
      <LegendSwatch color={COLOR_UNSPENT} dashed label={SERIES_LABEL.unspent} suffix="(you)" />
      <LegendSwatch color={COLOR_PROGRESS} dashed label={SERIES_LABEL.in_progress} suffix="(you)" />
      <LegendSwatch color={COLOR_INCOME} label={SERIES_LABEL.income} suffix="(opp)" />
      <LegendSwatch color={COLOR_UNSPENT} label={SERIES_LABEL.unspent} suffix="(opp)" />
      <LegendSwatch color={COLOR_PROGRESS} label={SERIES_LABEL.in_progress} suffix="(opp)" />
    </span>
  );
}

function LegendSwatch({
  color,
  dashed,
  label,
  suffix,
}: {
  color: string;
  dashed?: boolean;
  label: string;
  suffix: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-text-muted">
      <svg width="22" height="6" aria-hidden>
        <line
          x1="1"
          y1="3"
          x2="21"
          y2="3"
          stroke={color}
          strokeWidth="2"
          strokeDasharray={dashed ? "3 3" : ""}
        />
      </svg>
      <span>
        {label} <span className="text-text-dim">{suffix}</span>
      </span>
    </span>
  );
}
