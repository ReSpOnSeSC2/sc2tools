/**
 * Pure layout + projection helpers for the Active Army & Workers chart.
 *
 * Keeping these out of ActiveArmyChart.tsx lets the chart component
 * stay under the 800-line cap and keeps the math unit-testable
 * without booting the React tree. Nothing here knows about React or
 * the DOM — every function is a deterministic data transform.
 */

import { computeArmyValue } from "@/lib/sc2-units";
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
 * Pre-unit-timeline fallback: convert ``food_used`` to a comparable
 * army-value scale by multiplying by 8. The number is empirical —
 * it lines an average mid-game army's supply count up with the
 * mineral+gas army value the unit-timeline path produces, so the
 * chart looks consistent across old (pre-v0.5) and new payloads.
 */
export const FOOD_FALLBACK_MULT = 8;
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
 * Build a per-time series for one side. Army value comes from the
 * unit_timeline at matching times when available (computed via the
 * unit cost catalog so it matches sc2replaystats's "army value"
 * methodology); falls back to ``food_used * 8`` for pre-v0.5
 * payloads where unit_timeline is absent.
 */
export function buildSeries(
  samples: StatsEvent[],
  unitTimeline: UnitTimelineEntry[] | undefined,
  side: "my" | "opp",
): SeriesPoint[] {
  if (!Array.isArray(samples) || samples.length === 0) return [];
  const tlByTime = new Map<number, Record<string, number>>();
  if (Array.isArray(unitTimeline)) {
    for (const entry of unitTimeline) {
      if (typeof entry?.time !== "number") continue;
      const composition =
        side === "my" ? entry.my : entry.opp;
      if (composition) tlByTime.set(Math.round(entry.time), composition);
    }
  }
  const out: SeriesPoint[] = [];
  for (const sample of samples) {
    const t = Math.round(Number(sample.time) || 0);
    const workers = Number(sample.food_workers) || 0;
    let army = 0;
    const composition = tlByTime.get(t);
    if (composition) {
      army = computeArmyValue(composition);
    } else {
      // Fallback: convert food_used to a comparable scale. Without
      // unit_timeline data we can't compute true mineral+gas value,
      // but the food*8 heuristic at least keeps the line shape
      // continuous through the chart while the user re-syncs an
      // older replay.
      army = (Number(sample.food_used) || 0) * FOOD_FALLBACK_MULT;
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
): ChartLayout | null {
  const my = Array.isArray(mySamples) ? mySamples : [];
  const opp = Array.isArray(oppSamples) ? oppSamples : [];
  if (my.length === 0 && opp.length === 0) return null;

  const mySeries = buildSeries(my, unitTimeline, "my");
  const oppSeries = buildSeries(opp, unitTimeline, "opp");
  const allSeries = mySeries.concat(oppSeries);

  const observedT = allSeries.reduce((m, p) => Math.max(m, p.t), 0);
  const maxT = Math.max(observedT, Number(gameLengthSec) || 0, 60);
  const armyVals = allSeries.map((p) => p.army);
  const workerVals = allSeries.map((p) => p.workers);
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
  const tOfX = (px: number) => {
    const clamped = Math.max(PAD_LEFT, Math.min(PAD_LEFT + innerW, px));
    return ((clamped - PAD_LEFT) / innerW) * maxT;
  };

  const xTicks: number[] = [];
  for (let t = 0; t <= maxT; t += X_TICK_STEP_SEC) xTicks.push(t);

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

/** Find the unit_timeline entry whose time is closest to ``t``. */
export function nearestTimelineEntry(
  timeline: UnitTimelineEntry[] | undefined,
  t: number,
): UnitTimelineEntry | null {
  if (!Array.isArray(timeline) || timeline.length === 0) return null;
  let best = timeline[0];
  let bestD = Math.abs((best.time || 0) - t);
  for (let i = 1; i < timeline.length; i++) {
    const d = Math.abs((timeline[i].time || 0) - t);
    if (d < bestD) {
      best = timeline[i];
      bestD = d;
    }
  }
  return best;
}
