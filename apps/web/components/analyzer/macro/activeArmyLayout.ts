/**
 * Pure layout + projection helpers for the Active Army & Workers chart.
 *
 * Keeping these out of ActiveArmyChart.tsx lets the chart component
 * stay under the 800-line cap and keeps the math unit-testable
 * without booting the React tree. Nothing here knows about React or
 * the DOM — every function is a deterministic data transform.
 */

import { computeArmyValue } from "@/lib/sc2-units";
import {
  deriveUnitComposition,
  type BuildEvent,
} from "./compositionAt";
import type {
  StatsEvent,
  UnitTimelineEntry,
} from "./MacroBreakdownPanel.types";

export const VIEW_W = 720;
export const VIEW_H = 240;
export const PAD_LEFT = 44;
export const PAD_RIGHT = 44;
export const PAD_TOP = 16;
export const PAD_BOTTOM = 28;
/**
 * Pre-unit-timeline fallback: estimate army value from ``food_used`` /
 * ``food_workers``. We use ``(food_used - food_workers) * 50`` because
 * a typical mid-game ground unit costs ~50 mineral+gas per supply
 * (Marine 50/1 → 50, Marauder 125/2 → 62, Stalker 175/2 → 87,
 * Roach 100/2 → 50, Hydralisk 150/2 → 75), and subtracting workers
 * isolates the fighting army. The previous heuristic
 * (``food_used * 8``) inflated the line during the worker-saturation
 * phase and clipped it during all-in pushes — the new formula tracks
 * sc2replaystats's "Army value" curve much more closely.
 */
export const FOOD_FALLBACK_MULT = 50;
export const ARMY_FLOOR = 200;
export const WORKER_FLOOR = 12;
export const X_TICK_STEP_SEC = 60;
export const Y_TICK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

export interface SeriesPoint {
  /** Game-time seconds. */
  t: number;
  /** Army value (mineral + gas Σ over non-worker units). */
  army: number;
  /** Worker count. */
  workers: number;
}

export interface ChartLayout {
  width: number;
  height: number;
  innerW: number;
  innerH: number;
  /** Plot area in pixels — used by the hover overlay. */
  plotLeft: number;
  plotTop: number;
  plotRight: number;
  plotBottom: number;
  maxT: number;
  armyMax: number;
  workerMax: number;
  xOf: (t: number) => number;
  yArmy: (a: number) => number;
  yWorker: (w: number) => number;
  /** Inverse of xOf — maps pixel x back to game-time seconds. */
  tOfX: (px: number) => number;
  myArmy: string;
  myWorker: string;
  oppArmy: string;
  oppWorker: string;
  xTicks: number[];
  /** Per-side, per-time data points keyed by time-second. */
  mySeries: SeriesPoint[];
  oppSeries: SeriesPoint[];
}

/**
 * Build a per-time series for one side. Army value is computed from
 * the SAME hybrid composition source the roster panel uses
 * (``deriveUnitComposition``): unit_timeline when populated for the
 * side, build-order-derived counts (with morphs + timeline deaths)
 * otherwise. This guarantees the chart line and the snapshot Army
 * total agree at every tick — previously the chart snapped strictly
 * on exact unit_timeline times and silently fell through to the
 * food*8 heuristic on misses, producing a number divergent from the
 * roster.
 *
 * Falls back to ``food_used * 8`` only when neither timeline nor
 * build_order is available for this side, matching the legacy
 * behaviour for pre-v0.5 slim payloads.
 */
export function buildSeries(
  samples: StatsEvent[],
  unitTimeline: UnitTimelineEntry[] | undefined,
  side: "my" | "opp",
  buildEvents?: BuildEvent[] | undefined,
): SeriesPoint[] {
  if (!Array.isArray(samples) || samples.length === 0) return [];
  const out: SeriesPoint[] = [];
  for (const sample of samples) {
    const t = Math.round(Number(sample.time) || 0);
    const workers = Number(sample.food_workers) || 0;
    const derived = deriveUnitComposition({
      timeline: unitTimeline,
      buildEvents,
      side,
      t,
    });
    let army: number;
    if (derived.source === "empty") {
      // Last-resort fallback for slim payloads (pre-v0.5 agents that
      // didn't ship ``unit_timeline`` or ``buildLog``): estimate army
      // value from net fighting supply. Subtracting workers from
      // ``food_used`` removes the saturation curve from the army line;
      // 50 mineral+gas per supply matches the average ground composition.
      const food = Number(sample.food_used) || 0;
      const fighting = Math.max(0, food - workers);
      army = fighting * FOOD_FALLBACK_MULT;
    } else {
      army = computeArmyValue(derived.units);
    }
    out.push({ t, army, workers });
  }
  return out;
}

/** Build the unified chart layout for a pair of (my, opp) series. */
export function buildLayout(
  mySamples: StatsEvent[],
  oppSamples: StatsEvent[],
  gameLengthSec: number | undefined,
  unitTimeline: UnitTimelineEntry[] | undefined,
  myBuildEvents?: BuildEvent[] | undefined,
  oppBuildEvents?: BuildEvent[] | undefined,
): ChartLayout | null {
  const my = Array.isArray(mySamples) ? mySamples : [];
  const opp = Array.isArray(oppSamples) ? oppSamples : [];
  if (my.length === 0 && opp.length === 0) return null;

  const mySeries = buildSeries(my, unitTimeline, "my", myBuildEvents);
  const oppSeries = buildSeries(opp, unitTimeline, "opp", oppBuildEvents);
  const allSeries = mySeries.concat(oppSeries);

  const observedT = allSeries.reduce((m, p) => Math.max(m, p.t), 0);
  const maxT = Math.max(observedT, Number(gameLengthSec) || 0, 60);
  const armyVals = allSeries.map((p) => p.army);
  const workerVals = allSeries.map((p) => p.workers);
  const armyPeak = Math.max(
    armyVals.length ? Math.max(...armyVals) : 0,
    ARMY_FLOOR,
  );
  const workerPeak = Math.max(
    workerVals.length ? Math.max(...workerVals) : 0,
    WORKER_FLOOR,
  );
  // Round axis maxima up to a "nice" number so the four Y-tick labels
  // read as round values (200/400/600/800 instead of 173/345/518/691).
  // Matches sc2replaystats's chart calibration.
  const armyMax = niceCeil(armyPeak);
  const workerMax = niceCeil(workerPeak);

  const innerW = VIEW_W - PAD_LEFT - PAD_RIGHT;
  const innerH = VIEW_H - PAD_TOP - PAD_BOTTOM;
  const xOf = (t: number) => PAD_LEFT + (t / maxT) * innerW;
  const yArmy = (a: number) => PAD_TOP + (1 - a / armyMax) * innerH;
  const yWorker = (w: number) => PAD_TOP + (1 - w / workerMax) * innerH;
  const tOfX = (px: number) => {
    const clamped = Math.max(PAD_LEFT, Math.min(PAD_LEFT + innerW, px));
    return ((clamped - PAD_LEFT) / innerW) * maxT;
  };

  // X-tick density adapts to game length so labels never collide:
  // ≤7 min → 60 s ticks; ≤15 min → 120 s; otherwise 180 s.
  const xTickStep =
    maxT > 900 ? 180 : maxT > 420 ? 120 : X_TICK_STEP_SEC;
  const xTicks: number[] = [];
  for (let t = 0; t <= maxT; t += xTickStep) xTicks.push(t);

  return {
    width: VIEW_W,
    height: VIEW_H,
    innerW,
    innerH,
    plotLeft: PAD_LEFT,
    plotTop: PAD_TOP,
    plotRight: VIEW_W - PAD_RIGHT,
    plotBottom: PAD_TOP + innerH,
    maxT,
    armyMax,
    workerMax,
    xOf,
    yArmy,
    yWorker,
    tOfX,
    myArmy: pathFor(mySeries, xOf, yArmy, "army"),
    myWorker: pathFor(mySeries, xOf, yWorker, "workers"),
    oppArmy: pathFor(oppSeries, xOf, yArmy, "army"),
    oppWorker: pathFor(oppSeries, xOf, yWorker, "workers"),
    xTicks,
    mySeries,
    oppSeries,
  };
}

function pathFor(
  series: SeriesPoint[],
  xOf: (t: number) => number,
  yOf: (v: number) => number,
  field: "army" | "workers",
): string {
  if (series.length === 0) return "";
  let out = "";
  for (let i = 0; i < series.length; i++) {
    const p = series[i];
    const cmd = i === 0 ? "M" : "L";
    out += `${cmd}${xOf(p.t).toFixed(1)},${yOf(p[field]).toFixed(1)} `;
  }
  return out.trim();
}

/**
 * Round a positive value up to the next "nice" axis maximum so the
 * Y-tick labels read as round numbers. Picks from a 1-2-2.5-5
 * sequence in each decade. Examples:
 *   niceCeil(173) → 200; niceCeil(345) → 400 (closest 5 step is 500
 *   but 4×100 keeps the four-tick grid clean for ~400-class peaks);
 *   niceCeil(518) → 600; niceCeil(2487) → 2500.
 *
 * The returned value is always >= the input. Zero or negative inputs
 * snap to the input unchanged (callers floor to ARMY_FLOOR before
 * calling so this branch is unreachable in practice).
 *
 * Exported for unit tests.
 */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return value;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const normalized = value / magnitude; // 1.0 ≤ x < 10
  let nice: number;
  if (normalized <= 1) nice = 1;
  else if (normalized <= 2) nice = 2;
  else if (normalized <= 2.5) nice = 2.5;
  else if (normalized <= 4) nice = 4;
  else if (normalized <= 5) nice = 5;
  else if (normalized <= 6) nice = 6;
  else if (normalized <= 8) nice = 8;
  else nice = 10;
  return nice * magnitude;
}

/**
 * Find the series point whose time is closest to ``t``. Returns
 * ``null`` for an empty series. Linear scan is fine — series length
 * caps at ~50 entries on a 25-minute game (one per 30 s).
 */
export function nearestPoint(
  series: SeriesPoint[],
  t: number,
): SeriesPoint | null {
  if (!series || series.length === 0) return null;
  let best = series[0];
  let bestD = Math.abs(best.t - t);
  for (let i = 1; i < series.length; i++) {
    const d = Math.abs(series[i].t - t);
    if (d < bestD) {
      best = series[i];
      bestD = d;
    }
  }
  return best;
}

