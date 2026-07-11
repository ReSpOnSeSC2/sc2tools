/**
 * gameTimeline — pure derivations for the per-game deep-dive timeline.
 *
 * Everything in this module is a deterministic function of its inputs
 * (no React, no recharts, no network) so the InteractiveTimeline chart
 * math is testable in isolation:
 *
 *   - {@link buildTimelinePoints} merges the macro-breakdown payload's
 *     `stats_events[]` / `opp_stats_events[]` (shape in
 *     components/analyzer/macro/MacroBreakdownPanel.types.ts) into one
 *     time-sorted series a chart can bind to directly.
 *   - {@link detectBattles} finds the largest army-value drops — the
 *     same "biggest drop inside a bounded window" idea lib/lossAutopsy.ts
 *     uses for its one-sided-fight rule — and returns them as fight
 *     markers for the timeline.
 *   - {@link readoutAt} answers "what was true at this moment" for the
 *     scrub cursor (supply, minerals, army values) using last-known-value
 *     semantics so misaligned my/opp sample times never blank a field.
 *   - {@link parseClockToSeconds} converts the `m:ss` game-clock strings
 *     other surfaces emit (loss-autopsy timestamps) back into seconds so
 *     clicking them can scrub the timeline.
 */

import type { StatsEvent } from "@/components/analyzer/macro/MacroBreakdownPanel.types";

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

/** One merged sample of both players' state at a game-time second. */
export interface TimelinePoint {
  time: number;
  /** Σ minerals+gas of my alive non-worker units (agent v0.5.11+). */
  myArmy: number | null;
  /** Opponent's army value at this time. */
  oppArmy: number | null;
  /** My current mineral bank. */
  myMinerals: number | null;
  /** My supply used (food_used, clamped to the game's 200 ceiling). */
  mySupply: number | null;
  /** My supply cap (food_made, clamped to the game's 200 ceiling). */
  mySupplyCap: number | null;
  /** My worker supply (food_workers). */
  myWorkers: number | null;
  /** Opponent supply used, when their stats stream exists. */
  oppSupply: number | null;
}

/** One detected fight — a bounded window where army value dropped. */
export interface BattleMarker {
  /** Window start, seconds. This is where the timeline pin sits. */
  start: number;
  /** Window end, seconds. */
  end: number;
  /** My army value lost across the window (≥ 0). */
  myLoss: number;
  /** Opponent army value lost across the same window (≥ 0). */
  oppLoss: number;
  /** myLoss + oppLoss — used for ranking overlapping candidates. */
  magnitude: number;
}

/** Snapshot readout for the scrub cursor's "at this moment" line. */
export interface MomentReadout {
  /** The time the readout answers for (clamped into the sampled range). */
  time: number;
  mySupply: number | null;
  mySupplyCap: number | null;
  myWorkers: number | null;
  myMinerals: number | null;
  myArmy: number | null;
  oppArmy: number | null;
}

export interface DetectBattlesOptions {
  /** Max seconds a single drop window may span. Default 45 (mirrors
   *  lossAutopsy's FIGHT_WINDOW_SEC). */
  windowSec?: number;
  /** Minimum army value lost (on either side) for a drop to count as a
   *  fight. Default 400 (mirrors lossAutopsy's FIGHT_MIN_MY_LOSS). */
  minLoss?: number;
  /** Max number of markers returned. Default 6. */
  maxMarkers?: number;
  /** Two candidate windows closer than this are treated as the same
   *  fight — the bigger one wins. Default 10 s. */
  mergePadSec?: number;
}

// ---------------------------------------------------------------------------
// Series building.
// ---------------------------------------------------------------------------

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The game's hard supply ceiling. Tracker events report raw
 *  ``food_made``/``food_used``, which keep counting past 200 when a
 *  player overbuilds overlords/depots — but in-game supply never
 *  exceeds 200, so a readout like "180/212" reads as a bug to any
 *  SC2 player. Clamp at ingestion so every downstream surface
 *  (chart line, tooltip, readout bar, aria labels) agrees with what
 *  the game itself would have displayed. */
const SC2_MAX_SUPPLY = 200;

function supplyOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  return n === null ? null : Math.min(n, SC2_MAX_SUPPLY);
}

/**
 * Merge the two stats-event streams into one time-sorted point list.
 * Missing streams (slim payloads, pre-v0.5.11 agents) simply leave
 * their fields null — callers decide how to degrade.
 */
export function buildTimelinePoints(
  statsEvents: ReadonlyArray<StatsEvent> | null | undefined,
  oppStatsEvents: ReadonlyArray<StatsEvent> | null | undefined,
): TimelinePoint[] {
  const byTime = new Map<number, TimelinePoint>();
  const pointAt = (time: number): TimelinePoint => {
    let p = byTime.get(time);
    if (!p) {
      p = {
        time,
        myArmy: null,
        oppArmy: null,
        myMinerals: null,
        mySupply: null,
        mySupplyCap: null,
        myWorkers: null,
        oppSupply: null,
      };
      byTime.set(time, p);
    }
    return p;
  };
  for (const ev of statsEvents ?? []) {
    const t = numOrNull(ev?.time);
    if (t === null || t < 0) continue;
    const p = pointAt(t);
    p.myArmy = numOrNull(ev.army_value);
    p.myMinerals = numOrNull(ev.minerals_current);
    p.mySupply = supplyOrNull(ev.food_used);
    p.mySupplyCap = supplyOrNull(ev.food_made);
    p.myWorkers = numOrNull(ev.food_workers);
  }
  for (const ev of oppStatsEvents ?? []) {
    const t = numOrNull(ev?.time);
    if (t === null || t < 0) continue;
    const p = pointAt(t);
    p.oppArmy = numOrNull(ev.army_value);
    p.oppSupply = supplyOrNull(ev.food_used);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------------------
// Battle detection.
// ---------------------------------------------------------------------------

interface ArmySample {
  time: number;
  army: number;
}

function armySeries(
  events: ReadonlyArray<StatsEvent> | null | undefined,
): ArmySample[] {
  const out: ArmySample[] = [];
  for (const ev of events ?? []) {
    const t = numOrNull(ev?.time);
    const army = numOrNull(ev?.army_value);
    if (t === null || army === null) continue;
    out.push({ time: t, army });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** Nearest sample's army value at time t; null on empty input.
 *  (Same semantics as lossAutopsy's armyAt.) */
function armyAt(series: ReadonlyArray<ArmySample>, t: number): number | null {
  if (series.length === 0) return null;
  let best = series[0];
  let bestD = Math.abs(best.time - t);
  for (let i = 1; i < series.length; i++) {
    const d = Math.abs(series[i].time - t);
    if (d < bestD) {
      best = series[i];
      bestD = d;
    }
  }
  return best.army;
}

interface DropCandidate {
  start: number;
  end: number;
  loss: number;
}

/** Every windowed drop of at least minLoss on one side's series. */
function dropCandidates(
  series: ReadonlyArray<ArmySample>,
  windowSec: number,
  minLoss: number,
): DropCandidate[] {
  const out: DropCandidate[] = [];
  for (let i = 0; i < series.length - 1; i++) {
    let bestLoss = 0;
    let bestEnd = series[i].time;
    for (let j = i + 1; j < series.length; j++) {
      const dt = series[j].time - series[i].time;
      if (dt > windowSec) break;
      const loss = series[i].army - series[j].army;
      if (loss > bestLoss) {
        bestLoss = loss;
        bestEnd = series[j].time;
      }
    }
    if (bestLoss >= minLoss) {
      out.push({ start: series[i].time, end: bestEnd, loss: bestLoss });
    }
  }
  return out;
}

/**
 * Detect fights: the largest army-value drops on EITHER side, deduped
 * so overlapping windows collapse into the single biggest engagement.
 * Deterministic and pure — same inputs always give the same markers.
 *
 * Requires `army_value` on the stats events (agent v0.5.11+ payloads);
 * returns [] when neither stream carries it.
 */
export function detectBattles(
  statsEvents: ReadonlyArray<StatsEvent> | null | undefined,
  oppStatsEvents: ReadonlyArray<StatsEvent> | null | undefined,
  options: DetectBattlesOptions = {},
): BattleMarker[] {
  const windowSec = options.windowSec ?? 45;
  const minLoss = options.minLoss ?? 400;
  const maxMarkers = options.maxMarkers ?? 6;
  const mergePadSec = options.mergePadSec ?? 10;

  const mySeries = armySeries(statsEvents);
  const oppSeries = armySeries(oppStatsEvents);
  if (mySeries.length < 2 && oppSeries.length < 2) return [];

  const windows: DropCandidate[] = [
    ...dropCandidates(mySeries, windowSec, minLoss),
    ...dropCandidates(oppSeries, windowSec, minLoss),
  ];
  if (windows.length === 0) return [];

  // Price both sides across each candidate window so a marker can say
  // "you lost 1.4k for 300" regardless of which side's series found it.
  const priced: BattleMarker[] = windows.map((w) => {
    const myBefore = armyAt(mySeries, w.start);
    const myAfter = armyAt(mySeries, w.end);
    const oppBefore = armyAt(oppSeries, w.start);
    const oppAfter = armyAt(oppSeries, w.end);
    const myLoss =
      myBefore !== null && myAfter !== null
        ? Math.max(0, Math.round(myBefore - myAfter))
        : 0;
    const oppLoss =
      oppBefore !== null && oppAfter !== null
        ? Math.max(0, Math.round(oppBefore - oppAfter))
        : 0;
    return {
      start: w.start,
      end: w.end,
      myLoss,
      oppLoss,
      magnitude: myLoss + oppLoss,
    };
  });

  // Greedy non-overlap selection: biggest engagement wins its window.
  // Sort is made fully deterministic with time tiebreakers.
  priced.sort((a, b) => b.magnitude - a.magnitude || a.start - b.start);
  const chosen: BattleMarker[] = [];
  for (const cand of priced) {
    if (chosen.length >= maxMarkers) break;
    const overlaps = chosen.some(
      (c) =>
        cand.start <= c.end + mergePadSec && cand.end >= c.start - mergePadSec,
    );
    if (overlaps) continue;
    chosen.push(cand);
  }
  chosen.sort((a, b) => a.start - b.start);
  return chosen;
}

// ---------------------------------------------------------------------------
// Scrub readout.
// ---------------------------------------------------------------------------

/**
 * "At this moment" readout: for each field, the last known value at or
 * before `t` (clamped into the sampled range). Last-known-value rather
 * than exact-match so a my-only or opp-only sample tick never blanks
 * the other side's numbers. Returns null only when there are no points.
 */
export function readoutAt(
  points: ReadonlyArray<TimelinePoint>,
  t: number,
): MomentReadout | null {
  if (!Array.isArray(points) || points.length === 0) return null;
  const first = points[0].time;
  const last = points[points.length - 1].time;
  const clamped = Math.min(Math.max(Number.isFinite(t) ? t : last, first), last);
  const out: MomentReadout = {
    time: clamped,
    mySupply: null,
    mySupplyCap: null,
    myWorkers: null,
    myMinerals: null,
    myArmy: null,
    oppArmy: null,
  };
  for (const p of points) {
    if (p.time > clamped) break;
    if (p.mySupply !== null) out.mySupply = p.mySupply;
    if (p.mySupplyCap !== null) out.mySupplyCap = p.mySupplyCap;
    if (p.myWorkers !== null) out.myWorkers = p.myWorkers;
    if (p.myMinerals !== null) out.myMinerals = p.myMinerals;
    if (p.myArmy !== null) out.myArmy = p.myArmy;
    if (p.oppArmy !== null) out.oppArmy = p.oppArmy;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clock helpers.
// ---------------------------------------------------------------------------

/** Parse an `m:ss` game-clock string back into seconds; null on junk. */
export function parseClockToSeconds(clock: string | null | undefined): number | null {
  if (typeof clock !== "string") return null;
  const m = /^\s*(\d+):(\d{2})\s*$/.exec(clock);
  if (!m) return null;
  const minutes = Number.parseInt(m[1], 10);
  const seconds = Number.parseInt(m[2], 10);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds > 59) {
    return null;
  }
  return minutes * 60 + seconds;
}
