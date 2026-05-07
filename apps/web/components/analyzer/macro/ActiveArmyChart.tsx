"use client";

import { useId, useMemo } from "react";
import { AlertCircle } from "lucide-react";
import { formatGameClock, leakKey } from "@/lib/macro";
import type { LeakItem, StatsEvent } from "./MacroBreakdownPanel.types";

export interface ActiveArmyChartProps {
  /** Player samples (food_used, food_workers, …). */
  samples: StatsEvent[];
  /** Opponent samples. May be empty when not extracted. */
  oppSamples: StatsEvent[];
  gameLengthSec?: number;
  /** Leak collection — drives vertical markers along the time axis. */
  leaks: LeakItem[];
  /** Stable id of the highlighted leak — receives an emphasised marker. */
  highlightedKey?: string | null;
}

const VIEW_W = 720;
const VIEW_H = 240;
const PAD_LEFT = 44;
const PAD_RIGHT = 44;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;
const ARMY_FOOD_MULT = 8;
const ARMY_FLOOR = 8 * ARMY_FOOD_MULT;
const WORKER_FLOOR = 12;
const X_TICK_STEP_SEC = 60;
const Y_TICK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

const COLOR_AXIS = "rgb(var(--text-dim))";
const COLOR_GRID = "rgb(var(--border))";
const COLOR_YOU = "rgb(var(--success))";
const COLOR_OPP = "rgb(var(--danger))";
const COLOR_HIGHLIGHT = "rgb(var(--accent-cyan))";
const COLOR_LEAK = "rgb(var(--warning))";

interface ChartLayout {
  width: number;
  height: number;
  innerW: number;
  innerH: number;
  maxT: number;
  armyMax: number;
  workerMax: number;
  xOf: (t: number) => number;
  yArmy: (a: number) => number;
  yWorker: (w: number) => number;
  myArmy: string;
  myWorker: string;
  oppArmy: string;
  oppWorker: string;
  xTicks: number[];
}

/**
 * Active Army & Workers chart — SVG renderer.
 *
 * Two solid army lines (food_used × 8 = army supply value) plus two
 * dashed worker lines, one per player, share the plot. Vertical
 * markers anchor leak events and the parent's highlighted leak — when
 * provided — paints in the cyan brand colour so the user can scrub
 * leak-list ↔ chart context. Samples missing → cyan empty state;
 * accessible <table> fallback lists leak timestamps for screen readers.
 */
export function ActiveArmyChart({
  samples,
  oppSamples,
  gameLengthSec,
  leaks,
  highlightedKey,
}: ActiveArmyChartProps) {
  const chartId = useId();
  const layout = useMemo(
    () => buildLayout(samples, oppSamples, gameLengthSec),
    [samples, oppSamples, gameLengthSec],
  );

  if (!layout) {
    return <ChartEmptyState />;
  }

  return (
    <figure className="space-y-2" aria-labelledby={`${chartId}-title`}>
      <figcaption
        id={`${chartId}-title`}
        className="flex flex-wrap items-center justify-between gap-2 text-caption text-text-muted"
      >
        <span className="font-semibold uppercase tracking-wider text-text">
          Active Army &amp; Workers
        </span>
        <Legend />
      </figcaption>

      <div className="overflow-x-auto rounded-lg border border-border bg-bg-elevated">
        <svg
          role="img"
          aria-label="Army supply value and worker count over game time, both players overlaid"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          preserveAspectRatio="none"
          className="block h-[200px] w-full min-w-[320px] sm:h-[240px] sm:min-w-[480px]"
        >
          <Grid layout={layout} />
          <XAxis layout={layout} />
          <LeakMarkers
            layout={layout}
            leaks={leaks}
            highlightedKey={highlightedKey}
          />
          <Lines layout={layout} />
          <YAxisLabels layout={layout} />
        </svg>
      </div>

      <AccessibleLeakTable leaks={leaks} highlightedKey={highlightedKey} />
    </figure>
  );
}

function ChartEmptyState() {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-bg-subtle p-4">
      <div className="inline-flex items-center gap-2 text-caption font-semibold text-accent-cyan">
        <AlertCircle className="h-4 w-4" aria-hidden />
        Chart samples unavailable
      </div>
      <p className="text-caption text-text-muted">
        The Active Army &amp; Workers chart needs the per-second sample stream
        from your SC2 agent. Re-run the agent or click Recompute to ask it
        to re-parse the replay file.
      </p>
    </div>
  );
}

function Legend() {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
      <Swatch color={COLOR_YOU} dashed={false} label="you army" />
      <Swatch color={COLOR_YOU} dashed label="you wkrs" />
      <Swatch color={COLOR_OPP} dashed={false} label="opp army" />
      <Swatch color={COLOR_OPP} dashed label="opp wkrs" />
      <Swatch color={COLOR_HIGHLIGHT} dashed label="leak" thin />
    </span>
  );
}

function Swatch({
  color,
  dashed,
  label,
  thin = false,
}: {
  color: string;
  dashed: boolean;
  label: string;
  thin?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <svg width="14" height="6" aria-hidden>
        <line
          x1="1"
          y1="3"
          x2="13"
          y2="3"
          stroke={color}
          strokeWidth={thin ? 1 : 2}
          strokeDasharray={dashed ? "2 2" : ""}
        />
      </svg>
      <span className="text-text-muted">{label}</span>
    </span>
  );
}

function Grid({ layout }: { layout: ChartLayout }) {
  return (
    <g aria-hidden>
      {Y_TICK_FRACTIONS.map((f) => {
        const y = PAD_TOP + (1 - f) * layout.innerH;
        return (
          <line
            key={`grid-${f}`}
            x1={PAD_LEFT}
            y1={y}
            x2={layout.width - PAD_RIGHT}
            y2={y}
            stroke={COLOR_GRID}
            strokeOpacity={0.6}
            strokeDasharray="2 4"
          />
        );
      })}
    </g>
  );
}

function YAxisLabels({ layout }: { layout: ChartLayout }) {
  return (
    <g aria-hidden>
      {Y_TICK_FRACTIONS.map((f) => {
        const y = PAD_TOP + (1 - f) * layout.innerH;
        return (
          <g key={`y-${f}`}>
            <text
              x={PAD_LEFT - 6}
              y={y + 3}
              textAnchor="end"
              fontSize="10"
              fill={COLOR_AXIS}
            >
              {Math.round(f * layout.armyMax)}
            </text>
            <text
              x={layout.width - PAD_RIGHT + 6}
              y={y + 3}
              textAnchor="start"
              fontSize="10"
              fill={COLOR_AXIS}
            >
              {Math.round(f * layout.workerMax)}
            </text>
          </g>
        );
      })}
      <text
        x={PAD_LEFT - 6}
        y={PAD_TOP - 4}
        textAnchor="end"
        fontSize="9"
        fill={COLOR_AXIS}
      >
        army
      </text>
      <text
        x={layout.width - PAD_RIGHT + 6}
        y={PAD_TOP - 4}
        textAnchor="start"
        fontSize="9"
        fill={COLOR_AXIS}
      >
        wkrs
      </text>
    </g>
  );
}

function XAxis({ layout }: { layout: ChartLayout }) {
  const baseY = PAD_TOP + layout.innerH;
  return (
    <g aria-hidden>
      <line
        x1={PAD_LEFT}
        y1={baseY}
        x2={layout.width - PAD_RIGHT}
        y2={baseY}
        stroke={COLOR_GRID}
      />
      {layout.xTicks.map((t) => (
        <g key={`x-${t}`}>
          <line
            x1={layout.xOf(t)}
            y1={baseY}
            x2={layout.xOf(t)}
            y2={baseY + 4}
            stroke={COLOR_AXIS}
            strokeOpacity={0.6}
          />
          <text
            x={layout.xOf(t)}
            y={baseY + 16}
            textAnchor="middle"
            fontSize="10"
            fill={COLOR_AXIS}
          >
            {formatGameClock(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

function Lines({ layout }: { layout: ChartLayout }) {
  return (
    <g>
      {layout.oppWorker ? (
        <path
          d={layout.oppWorker}
          fill="none"
          stroke={COLOR_OPP}
          strokeWidth={1.5}
          strokeDasharray="3 3"
        />
      ) : null}
      {layout.myWorker ? (
        <path
          d={layout.myWorker}
          fill="none"
          stroke={COLOR_YOU}
          strokeWidth={1.5}
          strokeDasharray="3 3"
        />
      ) : null}
      {layout.oppArmy ? (
        <path
          d={layout.oppArmy}
          fill="none"
          stroke={COLOR_OPP}
          strokeWidth={1.75}
        />
      ) : null}
      {layout.myArmy ? (
        <path
          d={layout.myArmy}
          fill="none"
          stroke={COLOR_YOU}
          strokeWidth={1.75}
        />
      ) : null}
    </g>
  );
}

function LeakMarkers({
  layout,
  leaks,
  highlightedKey,
}: {
  layout: ChartLayout;
  leaks: LeakItem[];
  highlightedKey?: string | null;
}) {
  const baseY = PAD_TOP + layout.innerH;
  return (
    <g aria-hidden>
      {leaks.map((leak, idx) => {
        if (typeof leak.time !== "number" || !Number.isFinite(leak.time)) {
          return null;
        }
        const id = leakKey(leak, idx);
        const highlighted = id === highlightedKey;
        const x = layout.xOf(Math.max(0, Math.min(layout.maxT, leak.time)));
        return (
          <g key={id}>
            <line
              x1={x}
              y1={PAD_TOP}
              x2={x}
              y2={baseY}
              stroke={highlighted ? COLOR_HIGHLIGHT : COLOR_LEAK}
              strokeWidth={highlighted ? 1.5 : 1}
              strokeOpacity={highlighted ? 0.95 : 0.5}
              strokeDasharray={highlighted ? "" : "2 3"}
            />
            <circle
              cx={x}
              cy={PAD_TOP + 4}
              r={highlighted ? 3.5 : 2.5}
              fill={highlighted ? COLOR_HIGHLIGHT : COLOR_LEAK}
              fillOpacity={highlighted ? 1 : 0.7}
            />
          </g>
        );
      })}
    </g>
  );
}

function AccessibleLeakTable({
  leaks,
  highlightedKey,
}: {
  leaks: LeakItem[];
  highlightedKey?: string | null;
}) {
  const timed = leaks.filter(
    (l) => typeof l.time === "number" && Number.isFinite(l.time),
  );
  if (timed.length === 0) return null;
  return (
    <table className="sr-only">
      <caption>Leak events plotted on the chart, ordered by game time.</caption>
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Leak</th>
          <th scope="col">Detail</th>
          <th scope="col">Highlighted</th>
        </tr>
      </thead>
      <tbody>
        {timed.map((leak, idx) => {
          const id = leakKey(leak, idx);
          return (
            <tr key={id}>
              <td>{formatGameClock(leak.time)}</td>
              <td>{leak.name || "Unnamed leak"}</td>
              <td>{leak.detail || ""}</td>
              <td>{id === highlightedKey ? "yes" : "no"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function buildLayout(
  mySamples: StatsEvent[],
  oppSamples: StatsEvent[],
  gameLengthSec: number | undefined,
): ChartLayout | null {
  const my = Array.isArray(mySamples) ? mySamples : [];
  const opp = Array.isArray(oppSamples) ? oppSamples : [];
  if (my.length === 0 && opp.length === 0) return null;

  const all = my.concat(opp);
  const observedT = all.reduce(
    (m, s) => Math.max(m, Number(s.time) || 0),
    0,
  );
  const maxT = Math.max(observedT, Number(gameLengthSec) || 0, 60);
  const armyVals = all.map(
    (s) => (Number(s.food_used) || 0) * ARMY_FOOD_MULT,
  );
  const workerVals = all.map((s) => Number(s.food_workers) || 0);
  const armyMax = Math.max(
    armyVals.length ? Math.max(...armyVals) : 0,
    ARMY_FLOOR,
  );
  const workerMax = Math.max(
    workerVals.length ? Math.max(...workerVals) : 0,
    WORKER_FLOOR,
  );

  const innerW = VIEW_W - PAD_LEFT - PAD_RIGHT;
  const innerH = VIEW_H - PAD_TOP - PAD_BOTTOM;
  const xOf = (t: number) => PAD_LEFT + (t / maxT) * innerW;
  const yArmy = (a: number) => PAD_TOP + (1 - a / armyMax) * innerH;
  const yWorker = (w: number) => PAD_TOP + (1 - w / workerMax) * innerH;

  const myProj = projectLines(my, xOf, yArmy, yWorker);
  const oppProj = projectLines(opp, xOf, yArmy, yWorker);

  const xTicks: number[] = [];
  for (let t = 0; t <= maxT; t += X_TICK_STEP_SEC) xTicks.push(t);

  return {
    width: VIEW_W,
    height: VIEW_H,
    innerW,
    innerH,
    maxT,
    armyMax,
    workerMax,
    xOf,
    yArmy,
    yWorker,
    myArmy: myProj.army,
    myWorker: myProj.worker,
    oppArmy: oppProj.army,
    oppWorker: oppProj.worker,
    xTicks,
  };
}

function projectLines(
  samples: StatsEvent[],
  xOf: (t: number) => number,
  yArmy: (a: number) => number,
  yWorker: (w: number) => number,
): { army: string; worker: string } {
  if (samples.length === 0) return { army: "", worker: "" };
  let armyPath = "";
  let workerPath = "";
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const t = Number(s.time) || 0;
    const army = (Number(s.food_used) || 0) * ARMY_FOOD_MULT;
    const workers = Number(s.food_workers) || 0;
    const cmd = i === 0 ? "M" : "L";
    armyPath += `${cmd}${xOf(t).toFixed(1)},${yArmy(army).toFixed(1)} `;
    workerPath += `${cmd}${xOf(t).toFixed(1)},${yWorker(workers).toFixed(1)} `;
  }
  return { army: armyPath.trim(), worker: workerPath.trim() };
}
