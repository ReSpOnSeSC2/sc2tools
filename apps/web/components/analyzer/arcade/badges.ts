/**
 * Arcade badges — pure progress rules for the Collection's badge grid.
 *
 * Buildle Brain is awarded inline by ModeRunner from its daily ledger.
 * The other five badges need run tracking the per-mode records don't
 * keep, so this module owns it:
 *
 *   - "perfect-days": N consecutive calendar days (user tz) on which
 *     every attempt at the mode was correct (Streak Hunter, Closer,
 *     Detective).
 *   - "correct-run": N consecutive correct attempts, across days
 *     (Veto Sleuth).
 *   - Tycoon: N consecutive ISO weeks whose settled Stock Market
 *     portfolio finished green.
 *
 * Everything here is a pure function of its inputs; useArcadeState
 * applies these reducers inside its single `update` path so progress
 * and the badge award land in the same persisted write.
 */

import { weekKey as isoWeekKeyInTz } from "./ArcadeEngine";
import type { ArcadeState, BadgeRun, StockMarketResult } from "./types";

export type BadgeRuleKind = "perfect-days" | "correct-run";

export interface BadgeRule {
  badgeId: string;
  kind: BadgeRuleKind;
  target: number;
}

/** Minerals granted the first time any badge is earned. */
export const BADGE_MINERAL_REWARD = 25;

/** Mode id → the badge its plays progress toward. */
export const PLAY_BADGE_RULES: Readonly<Record<string, BadgeRule>> = {
  "active-streak-hunter": { badgeId: "streak-hunter", kind: "perfect-days", target: 5 },
  "streak-veto": { badgeId: "veto-sleuth", kind: "correct-run", target: 3 },
  "closers-eye": { badgeId: "closer", kind: "perfect-days", target: 5 },
  "loss-pattern-sleuth": { badgeId: "detective", kind: "perfect-days", target: 5 },
};

export const TYCOON_BADGE_ID = "tycoon";
/** Consecutive green weeks Tycoon requires. */
export const TYCOON_GREEN_WEEKS = 5;
/** Settled weeks kept in state — enough to evaluate the Tycoon run. */
export const STOCK_MARKET_HISTORY_WEEKS = 12;

const DAY_MS = 86_400_000;
const WEEK_KEY_RE = /^(\d{4})-W(\d{2})$/;

const EMPTY_RUN: BadgeRun = {
  day: null,
  dayPerfect: false,
  perfectDaysBefore: 0,
  correctRun: 0,
};

/** True when ``day`` is exactly the calendar day after ``prevDay``. */
export function isNextDay(prevDay: string, day: string): boolean {
  const prev = Date.parse(`${prevDay}T00:00:00Z`);
  const next = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(prev) || Number.isNaN(next)) return false;
  return Math.round((next - prev) / DAY_MS) === 1;
}

/** Consecutive perfect days ending on the run's current day. */
export function perfectDayRun(run: BadgeRun): number {
  return run.dayPerfect ? run.perfectDaysBefore + 1 : 0;
}

/** Fold one attempt (on ``day``, in the user's tz) into a mode's run. */
export function advanceBadgeRun(
  prev: BadgeRun | undefined,
  day: string,
  correct: boolean,
): BadgeRun {
  const base = prev ?? EMPTY_RUN;
  const correctRun = correct ? base.correctRun + 1 : 0;
  if (base.day === day) {
    return { ...base, dayPerfect: base.dayPerfect && correct, correctRun };
  }
  const carried = base.day && isNextDay(base.day, day) ? perfectDayRun(base) : 0;
  return { day, dayPerfect: correct, perfectDaysBefore: carried, correctRun };
}

/** Whether a run satisfies its badge rule. */
export function playBadgeEarned(rule: BadgeRule, run: BadgeRun): boolean {
  const progress = rule.kind === "perfect-days" ? perfectDayRun(run) : run.correctRun;
  return progress >= rule.target;
}

/** Grant a badge (plus its mineral reward) unless it is already earned. */
export function awardBadge(state: ArcadeState, badgeId: string, now: Date): ArcadeState {
  if (state.badges[badgeId]) return state;
  return {
    ...state,
    badges: { ...state.badges, [badgeId]: { earnedAt: now.toISOString() } },
    minerals: state.minerals + BADGE_MINERAL_REWARD,
  };
}

/**
 * Record one attempt's badge progress and award the badge when its rule
 * is met. Modes without a rule pass through unchanged.
 */
export function applyPlayBadgeProgress(
  state: ArcadeState,
  play: { modeId: string; day: string; correct: boolean },
  now: Date,
): ArcadeState {
  const rule = PLAY_BADGE_RULES[play.modeId];
  if (!rule) return state;
  const run = advanceBadgeRun(state.badgeRuns?.[play.modeId], play.day, play.correct);
  const next: ArcadeState = {
    ...state,
    badgeRuns: { ...(state.badgeRuns ?? {}), [play.modeId]: run },
  };
  return playBadgeEarned(rule, run) ? awardBadge(next, rule.badgeId, now) : next;
}

/** The ISO week key before ``weekKey`` ("2026-W01" → "2025-W53" or "-W52"). */
export function previousWeekKey(weekKey: string): string | null {
  const match = WEEK_KEY_RE.exec(weekKey);
  if (!match) return null;
  const monday = isoWeekMonday(Number(match[1]), Number(match[2]));
  return isoWeekKeyInTz(new Date(monday.getTime() - 7 * DAY_MS), "UTC");
}

/** Consecutive green (pnlPct > 0) settled weeks ending at ``weekKey``. */
export function greenWeekRun(
  history: Record<string, StockMarketResult> | undefined,
  weekKey: string,
): number {
  let run = 0;
  let key: string | null = weekKey;
  while (key && (history?.[key]?.pnlPct ?? 0) > 0) {
    run += 1;
    key = previousWeekKey(key);
  }
  return run;
}

/**
 * Record a finished Stock Market week and award Tycoon on a long enough
 * green run. Idempotent: a week that is already settled is left as is,
 * so re-renders and replayed mutations can't rewrite its result.
 */
export function applyStockMarketSettlement(
  state: ArcadeState,
  result: { weekKey: string; pnlPct: number },
  now: Date,
): ArcadeState {
  if (!WEEK_KEY_RE.test(result.weekKey) || !Number.isFinite(result.pnlPct)) return state;
  const history = state.stockMarketHistory ?? {};
  if (history[result.weekKey]) return state;
  const merged: Record<string, StockMarketResult> = {
    ...history,
    [result.weekKey]: { pnlPct: result.pnlPct, settledAt: now.toISOString() },
  };
  const kept = Object.keys(merged).sort().slice(-STOCK_MARKET_HISTORY_WEEKS);
  const next: ArcadeState = {
    ...state,
    stockMarketHistory: Object.fromEntries(kept.map((k) => [k, merged[k]])),
  };
  return greenWeekRun(next.stockMarketHistory, result.weekKey) >= TYCOON_GREEN_WEEKS
    ? awardBadge(next, TYCOON_BADGE_ID, now)
    : next;
}

function isoWeekMonday(year: number, week: number): Date {
  // ISO week 1 is the week containing January 4th.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7; // Monday=0..Sunday=6
  return new Date(jan4.getTime() + ((week - 1) * 7 - jan4Dow) * DAY_MS);
}
