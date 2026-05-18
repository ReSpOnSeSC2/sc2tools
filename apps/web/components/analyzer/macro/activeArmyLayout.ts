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
  type CompositionSource,
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
 * Last-resort fallback for slim payloads that ship neither
 * ``army_value`` (agent v0.5.11+) nor ``unit_timeline`` / ``buildLog``
 * we could derive composition from. Estimates army value from
 * ``(food_used - food_workers) * 50`` — ~50 mineral+gas per supply is
 * the average mid-game ground unit (Marine 50/1, Marauder 125/2,
 * Stalker 175/2, Roach 100/2, Hydralisk 150/2). The result is heavily
 * gated upstream: it only fires when ``armyFromValue`` and
 * ``armyFromUnits`` both refused to provide a number, and it's clamped
 * to ``ARMY_FALLBACK_CAP`` so a runaway sample (food_used > 200 due to
 * sc2reader edge cases) can't synthesise a vertical spike like the
 * 9 200-on-an-empty-timeline regression that motivated this refactor.
 */
export const FOOD_FALLBACK_MULT = 50;
/**
 * Cap for the food-supply fallback. 200 supply × 50 = 10 000 is the
 * theoretical max but real fighting supply rarely exceeds 180; the
 * cap mostly exists to neuter sc2reader edge cases where ``food_used``
 * spikes above 200 (the engine permits brief overflows during a wave
 * of parallel Larva morphs).
 */
export const ARMY_FALLBACK_CAP = 9000;
export const ARMY_FLOOR = 200;
export const WORKER_FLOOR = 12;
/**
 * Lower bound for the X-axis when a game length is unavailable AND no
 * samples were extracted (very-short replays or slim payloads). Keeps
 * the empty-state chart legible.
 */
export const MIN_AXIS_SECONDS = 60;
export const Y_TICK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

/**
 * Where the army number on a given sample came from. Surfaces in the
 * roster's source badge so users know whether the line is reading
 * sc2reader's authoritative number or a derived approximation.
 *
 *   - ``stats``       sc2reader's ``minerals_used_active_forces`` +
 *                     ``vespene_used_active_forces`` from the sample.
 *                     Always preferred when present.
 *   - ``timeline``    Σ cost over the unit_timeline alive map at this
 *                     tick. Preferred over the build-order path because
 *                     it's death-aware.
 *   - ``hybrid``      build-order cumulative count with timeline-derived
 *                     death subtraction applied.
 *   - ``build_order`` build-order cumulative count, no death info.
 *                     CLAMPED to ``ARMY_FALLBACK_CAP`` — without
 *                     timeline-derived deaths this is the runaway path
 *                     that produced the late-game 9 200 regression.
 *   - ``fallback``    food-supply heuristic, clamped to
 *                     ``ARMY_FALLBACK_CAP``. Only fires when neither
 *                     ``army_value`` nor any composition source is
 *                     available — pre-v0.5 slim payloads.
 *   - ``empty``       no data at all; army renders as 0 / "—".
 */
export type ArmySource =
  | "stats"
  | "timeline"
  | "hybrid"
  | "build_order"
  | "fallback"
  | "empty";

export interface SeriesPoint {
  /** Game-time seconds. */
  t: number;
  /** Army value (mineral + gas Σ over non-worker units). */
  army: number;
  /** Worker count. */
  workers: number;
  /** Provenance of ``army`` for this sample — drives the source badge. */
  armySource: ArmySource;
  /**
   * Alive non-worker, non-building unit composition at ``t``. Tooltip
   * and roster both read this so they can never disagree on the unit
   * list shown alongside the army number.
   */
  units: Record<string, number>;
  /** Provenance of ``units`` (timeline / hybrid / build_order / empty). */
  unitsSource: CompositionSource;
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
 * Build a per-time series for one side. Each ``SeriesPoint`` carries
 * the army number, worker count, AND the alive unit composition at
 * the tick — the chart's tooltip, the chart line, and the roster
 * panel all consume the same series via ``seriesAt`` so they cannot
 * disagree on what was alive at hover time. Single source of truth.
 *
 * Army value resolution order, per sample:
 *
 *   1. ``sample.army_value`` — sc2reader's
 *      ``minerals_used_active_forces`` + ``vespene_used_active_forces``,
 *      emitted by agent v0.5.11+. This is the same number the in-game
 *      Army graph and sc2replaystats's Army Value chart show, so
 *      using it directly removes ALL of the fragility around the
 *      timeline/build-order fallback cascade. ``armySource = "stats"``.
 *
 *   2. ``computeArmyValue(derived.units)`` — Σ cost over the alive
 *      composition derived by ``deriveUnitComposition`` (timeline-
 *      preferred, build-order + timeline-deaths fallback). Used when
 *      ``army_value`` is missing from the wire payload (legacy
 *      uploads). Clamped to ``ARMY_FALLBACK_CAP`` when the derivation
 *      came from build-order without timeline-derived deaths — that's
 *      the path that previously produced the 9 200-late-game spike,
 *      because cumulative builds keep growing without death info.
 *
 *   3. Food-supply heuristic clamped to ``ARMY_FALLBACK_CAP`` —
 *      ``(food_used - food_workers) * 50``. Only fires when both
 *      ``army_value`` and a populated composition source are absent.
 *
 *   4. Zero with ``armySource = "empty"`` when nothing's available.
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
    const stats = sampleArmyValue(sample);
    let army: number;
    let armySource: ArmySource;
    if (stats != null) {
      army = stats;
      armySource = "stats";
    } else if (derived.source === "timeline") {
      army = computeArmyValue(derived.units);
      armySource = "timeline";
    } else if (derived.source === "hybrid") {
      army = computeArmyValue(derived.units);
      armySource = "hybrid";
    } else if (derived.source === "build_order") {
      // No timeline-derived deaths available — the cumulative count
      // grows monotonically across the game. Clamp so an end-of-game
      // sample on a heavy-production replay can't render as a
      // vertical spike. The roster surfaces a "build order" badge
      // for this case so users know the absolute number is upper-
      // bounded rather than authoritative.
      army = Math.min(ARMY_FALLBACK_CAP, computeArmyValue(derived.units));
      armySource = "build_order";
    } else {
      // ``derived.source === "empty"`` — slim payload with no
      // unit_timeline AND no buildLog. Last-resort food-supply
      // heuristic, hard-capped so a runaway food_used reading can't
      // produce a misleading spike.
      const food = Number(sample.food_used) || 0;
      const fighting = Math.max(0, food - workers);
      const heuristic = fighting * FOOD_FALLBACK_MULT;
      army = Math.min(ARMY_FALLBACK_CAP, heuristic);
      armySource = heuristic > 0 ? "fallback" : "empty";
    }
    out.push({
      t,
      army,
      workers,
      armySource,
      units: derived.units,
      unitsSource: derived.source,
    });
  }
  return out;
}

/**
 * Read the authoritative army value off a stats sample, or null when
 * the agent didn't emit it (legacy payload). Negative values are
 * treated as missing — sc2reader has been observed to surface -1 on
 * the very first tick before its internal counters are warm.
 */
function sampleArmyValue(sample: StatsEvent): number | null {
  const v = (sample as { army_value?: number }).army_value;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return v;
}

/**
 * Build the unified chart layout from a PRE-BUILT pair of series.
 *
 * Why the series come in pre-built rather than being constructed here:
 * the roster panel beneath the chart needs the SAME SeriesPoint at
 * hover time so the tooltip number and the roster header's "Army NNN"
 * cannot diverge. The parent (``MacroChartSection``) builds the
 * series once via ``buildSeries`` and threads the result to both
 * children.
 */
export function buildLayout(
  mySeries: SeriesPoint[],
  oppSeries: SeriesPoint[],
  gameLengthSec: number | undefined,
): ChartLayout | null {
  const myArrRaw = Array.isArray(mySeries) ? mySeries : [];
  const oppArrRaw = Array.isArray(oppSeries) ? oppSeries : [];
  if (myArrRaw.length === 0 && oppArrRaw.length === 0) return null;

  const observedT = Math.max(
    myArrRaw.reduce((m, p) => Math.max(m, p.t), 0),
    oppArrRaw.reduce((m, p) => Math.max(m, p.t), 0),
  );
  // Trust the replay's authoritative length whenever the agent reported
  // a positive game_length_sec — that's the actual seconds-played from
  // the replay header. The axis (and every consumer of maxT) ends
  // exactly where the game ended, with no padding past the leaver/GG.
  // When the field is missing or zero (very old payloads, broken
  // metadata) we fall back to the latest observed sample, floored to
  // MIN_AXIS_SECONDS so a 12-second test-replay still draws an axis.
  const lengthFromMeta = Number(gameLengthSec) || 0;
  const maxT =
    lengthFromMeta > 0
      ? lengthFromMeta
      : Math.max(observedT, MIN_AXIS_SECONDS);

  // Drop any samples that landed past the authoritative game end (can
  // happen when sc2reader's stat tick fires inside the post-game grace
  // period). Without this, the line would continue past plotRight and
  // the SVG would draw it outside the plot area on browsers that don't
  // honour the implicit viewBox clip.
  const myArr =
    lengthFromMeta > 0
      ? myArrRaw.filter((p) => p.t <= maxT)
      : myArrRaw;
  const oppArr =
    lengthFromMeta > 0
      ? oppArrRaw.filter((p) => p.t <= maxT)
      : oppArrRaw;
  const allSeries = myArr.concat(oppArr);
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

  const xTicks = computeXTicks(maxT);

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
    myArmy: pathFor(myArr, xOf, yArmy, "army"),
    myWorker: pathFor(myArr, xOf, yWorker, "workers"),
    oppArmy: pathFor(oppArr, xOf, yArmy, "army"),
    oppWorker: pathFor(oppArr, xOf, yWorker, "workers"),
    xTicks,
    mySeries: myArr,
    oppSeries: oppArr,
  };
}

/**
 * Compute X-axis tick positions for the chart. Targets ~5–7 evenly-
 * spaced labels for ANY game length so the axis never collides at the
 * mobile minimum width (320 px ≈ 0.44× viewBox scale) and never sits
 * sparse at desktop width. Steps are picked from the same human-
 * readable cadence — 30 s, 1 m, 2 m, 3 m, 5 m, 10 m — that
 * sc2replaystats's chart uses, so a viewer's mental model carries
 * across charts.
 *
 * Examples:
 *   2 min game →  30 s step → 0:00, 0:30, 1:00, 1:30, 2:00
 *   5 min     →  60 s step → 0:00, 1:00, 2:00, 3:00, 4:00, 5:00
 *  10 min     → 120 s step → 0:00 … 10:00 (6 labels)
 *  15 min     → 180 s step → 0:00 … 15:00 (6 labels)
 *  25 min     → 300 s step → 0:00 … 25:00 (6 labels)
 *  45 min     → 600 s step → 0:00 … 40:00 + the final cap label
 *
 * The closing tick is always pinned to ``maxT`` exactly so a 27:42
 * game reads "0:00 … 27:42" rather than ending at the previous tick.
 * Exported for the test suite.
 */
export function computeXTicks(maxT: number): number[] {
  const step = pickXTickStep(maxT);
  const ticks: number[] = [];
  for (let t = 0; t < maxT; t += step) ticks.push(t);
  // Always include the exact end-of-game marker. If it would sit
  // closer than ~35% of a step to the previous tick we drop the
  // crowding inner tick instead of the labelled endpoint — readers
  // care more about "the game ended at 27:42" than the round 27:00.
  const endTick = Math.round(maxT);
  if (ticks.length === 0) {
    ticks.push(endTick);
  } else {
    const prev = ticks[ticks.length - 1];
    if (endTick - prev < step * 0.35) {
      ticks[ticks.length - 1] = endTick;
    } else {
      ticks.push(endTick);
    }
  }
  return ticks;
}

function pickXTickStep(maxT: number): number {
  if (maxT <= 180) return 30;       // ≤3 min  → 30 s
  if (maxT <= 360) return 60;       // ≤6 min  → 1 m
  if (maxT <= 720) return 120;      // ≤12 min → 2 m
  if (maxT <= 1200) return 180;     // ≤20 min → 3 m
  if (maxT <= 1800) return 300;     // ≤30 min → 5 m
  return 600;                       //  >30 min → 10 m
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
 * caps at ~150 entries on a 25-minute game (one per 10 s).
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

/**
 * Find the latest series point with ``p.t <= t``. Used for hover-
 * locked lookups so a hover at t=945 with samples at 930 and 960
 * picks 930 — never 960. Without this, the roster's worker count
 * and the chart's army number could "leak" future state into a past
 * hover (e.g. show 52 workers at t=945 because the next sample at
 * t=960 has 52 workers, even though only 50 had been built by 945).
 *
 * Returns the FIRST series point when ``t`` precedes every sample
 * (so very-early hovers still get a non-null read), and the last
 * point when ``t`` exceeds every sample (so end-of-game hovers
 * snap to the final reading rather than going null).
 */
export function nearestPriorPoint(
  series: SeriesPoint[],
  t: number,
): SeriesPoint | null {
  if (!series || series.length === 0) return null;
  let best: SeriesPoint | null = null;
  for (let i = 0; i < series.length; i++) {
    if (series[i].t <= t) {
      best = series[i];
    } else {
      break; // series is ascending by t (buildSeries iterates samples in order)
    }
  }
  // Pre-first-sample hover: return the first point so the UI never
  // flashes empty. The user's hover time IS clamped >= 0 upstream so
  // the only way this fires is when sample times start above 0.
  return best ?? series[0];
}

/**
 * Snapshot read at a hovered ``t``: pulls the same SeriesPoint for
 * the chart tooltip AND the roster panel so they cannot disagree on
 * army value, worker count, or alive composition. Both sides return
 * a point (or null when the side's series is empty); callers render
 * "—" for null.
 */
export function seriesAt(
  layout: { mySeries: SeriesPoint[]; oppSeries: SeriesPoint[] },
  t: number,
): { my: SeriesPoint | null; opp: SeriesPoint | null } {
  return {
    my: nearestPriorPoint(layout.mySeries, t),
    opp: nearestPriorPoint(layout.oppSeries, t),
  };
}

