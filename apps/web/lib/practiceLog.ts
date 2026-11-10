/**
 * Practice log — types and pure helpers for /practice and the stored grade
 * on a game page.
 *
 * The API grades every game in a matchup whose synced Ghost target was armed
 * before the game (apps/api/src/services/practiceLog.js) and keeps the record
 * on the game. Nothing here does I/O; dates are read in the viewer's local
 * time so "this week" is the player's week.
 */

import type { GhostGradeLetter } from "@/lib/ghostGrade";

export interface PracticeStep { i: number; name: string; t: number; supply: number | null }
export interface PracticeTarget {
  hash: string;
  name: string | null;
  current: boolean;
  armedAt: string | null;
  steps: PracticeStep[] | null;
}
export interface PracticeHistoryRow {
  gameId: string;
  date: string;
  grade: GhostGradeLetter;
  avgDrift: number;
  matched: number;
  total: number;
  via: "ingest" | "request";
}
export interface PracticeStepStat { i: number; name: string; t: number; games: number; hit: number; avgDrift: number | null }
export interface PracticeSummary {
  matchup: string;
  target: PracticeTarget | null;
  targets: Array<{ hash: string; name: string | null; games: number; lastPlayed: string | null; current: boolean }>;
  sample: { graded: number; ungraded: number; limit: number; capped: boolean };
  grades: Record<GhostGradeLetter, number>;
  /** Newest first. */
  history: PracticeHistoryRow[];
  divergence: Array<{ i: number; name: string; games: number; cut: number }>;
  steps: PracticeStepStat[] | null;
}
export interface PracticeDivergence { i: number; name: string; expectedT: number; actualT: number | null }
export interface PracticeWorstStep { i: number; name?: string; d: number | null }
/** The record stored on a game (``practice`` on the games row). */
export interface StoredPractice {
  targetHash: string;
  targetName: string;
  matchup: string;
  status?: "no_build_log";
  grade?: GhostGradeLetter;
  matched?: number;
  total?: number;
  avgDrift?: number;
  maxDrift?: number;
  firstDivergence?: PracticeDivergence | null;
  worstSteps?: PracticeWorstStep[];
  via: "ingest" | "request";
  gradedAt: string;
}
export interface PracticeGameRow {
  gameId: string;
  date: string | null;
  map: string | null;
  result: string | null;
  practice: {
    targetHash: string;
    targetName: string;
    status: "graded" | "no_build_log";
    grade: GhostGradeLetter | null;
    matched: number | null;
    total: number | null;
    avgDrift: number | null;
    maxDrift: number | null;
    firstDivergence: PracticeDivergence | null;
    worstSteps: PracticeWorstStep[];
    via: "ingest" | "request";
  };
}
export interface PracticeGamesPage { items: PracticeGameRow[]; nextCursor: string | null }

export const GRADE_ORDER: readonly GhostGradeLetter[] = ["S", "A", "B", "C", "D"];
const GRADE_SCORE: Record<GhostGradeLetter, number> = { S: 4, A: 3, B: 2, C: 1, D: 0 };
/** Sparkline length on /practice. */
export const SPARKLINE_GAMES = 30;
export const DEFAULT_WEEKLY_GOAL = 5;

/** B or better: the bar the weekly plan counts. */
export function isGoodGrade(grade: GhostGradeLetter): boolean {
  return GRADE_SCORE[grade] >= GRADE_SCORE.B;
}

export function practiceSummaryPath(matchup: string, targetHash?: string | null): string {
  const params = new URLSearchParams({ matchup });
  if (targetHash) params.set("targetHash", targetHash);
  return `/v1/practice/summary?${params}`;
}

export function practiceGamesPath(matchup: string, targetHash: string | null, cursor?: string | null): string {
  const params = new URLSearchParams({ matchup, limit: "20" });
  if (targetHash) params.set("targetHash", targetHash);
  if (cursor) params.set("cursor", cursor);
  return `/v1/practice/games?${params}`;
}

/**
 * Sparkline points of the newest SPARKLINE_GAMES grades, oldest first, in a
 * 0–1 box: x spreads the games evenly, y is 0 for S and 1 for D.
 */
export function gradeSparkline(history: readonly PracticeHistoryRow[]): Array<{ x: number; y: number; row: PracticeHistoryRow }> {
  const rows = history.slice(0, SPARKLINE_GAMES).reverse();
  const span = Math.max(1, rows.length - 1);
  return rows.map((row, index) => ({
    x: rows.length === 1 ? 0.5 : index / span,
    y: 1 - GRADE_SCORE[row.grade] / GRADE_SCORE.S,
    row,
  }));
}

/** Monday 00:00 of the viewer's local week containing ``now``. */
export function startOfLocalWeek(now: Date): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sinceMonday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - sinceMonday);
  return start;
}

/** This week's graded games and how many reached B or better. */
export function weekProgress(history: readonly PracticeHistoryRow[], now: Date, goal: number) {
  const since = startOfLocalWeek(now).getTime();
  const week = history.filter((row) => {
    const at = Date.parse(row.date);
    return Number.isFinite(at) && at >= since && at <= now.getTime();
  });
  const good = week.filter((row) => isGoodGrade(row.grade)).length;
  const target = Math.max(1, Math.round(goal));
  return { graded: week.length, good, goal: target, ratio: Math.min(1, good / target) };
}

/** "+12s late", "3s early", "on time" — a step's mean drift in words. */
export function driftText(drift: number | null): string {
  if (drift === null) return "never built";
  const rounded = Math.round(drift);
  if (Math.abs(rounded) <= 5) return rounded === 0 ? "on time" : `on time (${rounded > 0 ? "+" : ""}${rounded}s)`;
  return rounded > 0 ? `${rounded}s late` : `${-rounded}s early`;
}

/** m:ss of a game second. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Share of graded games at each grade, in display order. */
export function gradeShares(grades: Record<GhostGradeLetter, number>): Array<{ grade: GhostGradeLetter; games: number; share: number }> {
  const total = GRADE_ORDER.reduce((sum, grade) => sum + (grades[grade] ?? 0), 0);
  return GRADE_ORDER.map((grade) => ({ grade, games: grades[grade] ?? 0, share: total ? (grades[grade] ?? 0) / total : 0 }));
}
