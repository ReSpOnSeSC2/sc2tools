/**
 * gameCompare — the pure comparisons behind /app/compare?a=&b=.
 *
 * Two of the owner's games, read through the endpoints the game page
 * already uses (no server change), compared on one game clock:
 *
 *   timelines   workers, army value, income and supply per game from
 *               ``stats_events`` (the macro timeline's ``SeriesPoint``s),
 *               read at a shared cursor time with the delta A − B
 *   build diff  each player's build steps aligned by step NAME and
 *               OCCURRENCE: the 2nd Gateway in A pairs with the 2nd
 *               Gateway in B, using the Ghost Build grader's name
 *               normalisation (lib/ghostBuild ``normalizeGhostName``),
 *               with Δtime = A − B (positive: A was later)
 *   mechanics   SQ, supply-blocked seconds, the race mechanic
 *               (injects / chronos / MULEs, actual vs expected) and APM,
 *               each null when that game did not measure it — a missing
 *               value is never shown as zero
 *
 * Every function is deterministic and side-free so the page and its
 * tests agree exactly.
 */

import type { GameBuildOrderEvent, GameSummary } from "@/components/analyzer/game/types";
import type { MacroBreakdownData } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import type { SeriesPoint } from "@/components/analyzer/macro/activeArmyLayout";
import { normalizeGhostName } from "@/lib/ghostBuild";
import { computeEffectiveRace, getRaceDetail } from "@/lib/macro";
import { isWorkerUnit } from "@/lib/mapReplay";

/** Game ids as the game page accepts them: bounded, printable, no slashes. */
export function isCompareGameId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && /^[\x21-\x7e]+$/.test(value) && !value.includes("/");
}

/** The shareable comparison link. */
export function compareHref(a: string, b: string): string {
  return `/app/compare?${new URLSearchParams({ a, b })}`;
}

/* ── build-order diff ─────────────────────────────────────────── */

export interface CompareBuildStep {
  /** Normalised step name (lowercase letters and digits). */
  key: string;
  /** What the step is called on screen. */
  label: string;
  time: number;
}

export interface BuildDiffRow {
  /** ``${key}#${occurrence}``: stable and unique per row. */
  id: string;
  label: string;
  /** 1-based: the 3rd Pylon is occurrence 3. */
  occurrence: number;
  aTime: number | null;
  bTime: number | null;
  /** A − B in seconds; null when the step exists in one game only. */
  delta: number | null;
}

/** Build steps worth aligning: real, timed, non-worker events, in time order. */
export function compareBuildSteps(events: readonly GameBuildOrderEvent[] | null | undefined): CompareBuildStep[] {
  const steps: CompareBuildStep[] = [];
  for (const event of events ?? []) {
    if (!event || typeof event.name !== "string" || typeof event.time !== "number" || !Number.isFinite(event.time) || event.time < 0) continue;
    if (isWorkerUnit(event.name)) continue;
    const key = normalizeGhostName(event.name);
    if (!key) continue;
    steps.push({ key, label: (event.display || event.name).trim() || event.name, time: event.time });
  }
  return steps.sort((x, y) => x.time - y.time);
}

/**
 * Align two games' steps by name and occurrence. Rows come out in the
 * order the step first happened in either game (ties: A's order, then
 * name), so the diff reads like a build order.
 */
export function alignBuildOrders(a: readonly CompareBuildStep[], b: readonly CompareBuildStep[]): BuildDiffRow[] {
  const rows = new Map<string, BuildDiffRow>();
  const order: string[] = [];
  const place = (steps: readonly CompareBuildStep[], side: "a" | "b") => {
    const seen = new Map<string, number>();
    for (const step of [...steps].sort((x, y) => x.time - y.time)) {
      const occurrence = (seen.get(step.key) ?? 0) + 1;
      seen.set(step.key, occurrence);
      const id = `${step.key}#${occurrence}`;
      let row = rows.get(id);
      if (!row) {
        row = { id, label: step.label, occurrence, aTime: null, bTime: null, delta: null };
        rows.set(id, row);
        order.push(id);
      }
      if (side === "a") row.aTime = step.time;
      else row.bTime = step.time;
    }
  };
  place(a, "a");
  place(b, "b");
  const position = new Map(order.map((id, index) => [id, index]));
  const result = [...rows.values()].map((row) => ({
    ...row,
    delta: row.aTime !== null && row.bTime !== null ? row.aTime - row.bTime : null,
  }));
  return result.sort((x, y) => {
    const first = Math.min(x.aTime ?? Infinity, x.bTime ?? Infinity) - Math.min(y.aTime ?? Infinity, y.bTime ?? Infinity);
    return first || (position.get(x.id)! - position.get(y.id)!);
  });
}

/** Within ±5 s reads as the same timing; beyond ±20 s is a different build moment. */
export const DELTA_EVEN_SEC = 5;
export const DELTA_BIG_SEC = 20;

export type DeltaTone = "even" | "later" | "earlier" | "none";

/** Colour meaning of a Δ (A − B): later is worse for A, earlier better. */
export function deltaTone(delta: number | null): DeltaTone {
  if (delta === null || !Number.isFinite(delta)) return "none";
  if (Math.abs(delta) <= DELTA_EVEN_SEC) return "even";
  return delta > 0 ? "later" : "earlier";
}

/** "+12 s", "−8 s", "0 s", "1:05" style for big gaps: "+1:05". */
export function formatDelta(delta: number | null): string {
  if (delta === null || !Number.isFinite(delta)) return "—";
  const rounded = Math.round(delta);
  if (rounded === 0) return "0 s";
  const sign = rounded > 0 ? "+" : "−";
  const abs = Math.abs(rounded);
  return abs >= 60 ? `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}` : `${sign}${abs} s`;
}

/* ── timelines ────────────────────────────────────────────────── */

export type CompareMetricKey = "workers" | "army" | "income" | "supply";
export const COMPARE_METRICS: readonly CompareMetricKey[] = ["workers", "army", "income", "supply"];

/** Seconds past a game's last sample before its line counts as ended. */
export const SERIES_END_GRACE_SEC = 10;

/** The sample at or before ``t``; null before the first or after the game ended. */
export function pointAt(series: readonly SeriesPoint[], t: number): SeriesPoint | null {
  if (!series.length || !Number.isFinite(t)) return null;
  if (t > series[series.length - 1].t + SERIES_END_GRACE_SEC) return null;
  let lo = 0, hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? series[lo - 1] : null;
}

/** A − B rounded; null when either side has no value at the cursor. */
export function metricDelta(a: number | null, b: number | null): number | null {
  return a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) ? null : Math.round(a - b);
}

/* ── mechanics ────────────────────────────────────────────────── */

export interface CompareMechanics {
  sq: number | null;
  supplyBlockedSec: number | null;
  /** The race mechanic, e.g. "Injects" 34 of 41 expected. */
  mechanic: { label: string; actual: number; expected: number | null } | null;
  apm: number | null;
  macroScore: number | null;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The game page's Mechanics numbers for one game, with the same
 * precedence: SQ from the breakdown, then player stats, then the slim
 * row; supply block from credited windows, else the raw total.
 */
export function compareMechanics(breakdown: MacroBreakdownData | null | undefined, game: GameSummary | null | undefined): CompareMechanics {
  const raw = breakdown?.raw;
  const rawSq = raw?.sq, statsSq = breakdown?.player_stats?.me?.spq, rowSq = game?.spq;
  const sq = finite(rawSq) ? rawSq : finite(statsSq) ? statsSq : finite(rowSq) ? rowSq : null;
  let total = 0;
  for (const window of Array.isArray(raw?.supply_block_windows) ? raw.supply_block_windows : []) {
    const start = window?.start, end = window?.end, blocked = window?.blocked_sec;
    if (!finite(start) || !finite(end)) continue;
    total += finite(blocked) ? blocked : Math.max(0, end - start);
  }
  const rawBlocked = raw?.supply_blocked_seconds;
  const supplyBlockedSec = total > 0 ? Math.round(total) : finite(rawBlocked) ? Math.round(rawBlocked) : null;
  const detail = getRaceDetail(computeEffectiveRace(breakdown?.race ?? game?.myRace, raw));
  const actual = detail ? raw?.[detail.actualKey] : undefined;
  const expected = detail ? raw?.[detail.expectedKey] : undefined;
  const mechanic = detail && finite(actual)
    ? { label: detail.unitPlural.charAt(0).toUpperCase() + detail.unitPlural.slice(1), actual, expected: finite(expected) ? expected : null }
    : null;
  const rowApm = game?.apm, rowScore = game?.macroScore, breakdownScore = breakdown?.macro_score;
  const apm = finite(rowApm) && rowApm > 0 ? rowApm : null;
  const macroScore = finite(rowScore) ? rowScore : finite(breakdownScore) ? breakdownScore : null;
  return { sq, supplyBlockedSec, mechanic, apm, macroScore };
}

/* ── picker ───────────────────────────────────────────────────── */

export interface CompareCandidate { gameId: string; macroScore?: number | null; date?: string | null }

/** The best other win: highest macro score, then the most recent. */
export function bestWinCandidate<T extends CompareCandidate>(items: readonly T[], excludeId: string): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (!item || item.gameId === excludeId) continue;
    if (!best) { best = item; continue; }
    const score = finite(item.macroScore) ? item.macroScore : -Infinity;
    const bestScore = finite(best.macroScore) ? best.macroScore : -Infinity;
    if (score > bestScore || (score === bestScore && Date.parse(item.date ?? "") > Date.parse(best.date ?? ""))) best = item;
  }
  return best;
}
