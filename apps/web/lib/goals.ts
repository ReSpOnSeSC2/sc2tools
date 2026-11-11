/**
 * Personal goals — web types and helpers for GET/POST/PUT/DELETE
 * /v1/goals (apps/api/src/services/playerGoals.js is the contract).
 *
 * The API computes progress; this module turns it into copy: the progress
 * line, the minimum-sample guard ("9 more games before this rate counts"),
 * the period, the deep link to the analyzer section that lists the counted
 * games, and the default windows the New goal modal offers.
 */
import { createFormatter, formatDate, formatNumber, getServerFormatter, SSR_FORMAT_PREFS } from "@/lib/i18n/format";
import { analyzerViewHref } from "@/lib/analyzerViews";
import type { AnalyzerFilters } from "@/lib/filterContext";
import { todayKeyIn } from "@/lib/timeseries";

export type GoalType = "games_played" | "win_rate" | "mmr_reach" | "macro_avg" | "apm_avg" | "sq_avg" | "build_reps";
export type GoalRecurrence = "once" | "daily" | "weekly" | "monthly" | "season";
export type GoalBuild = { key: string; name: string; slug: string | null; source: "catalog" | "custom" };
export type GoalFilters = { matchup: string | null; map: string | null; ranked: boolean };
export type GoalParams = { target: number; minGames?: number; toon?: string | null; build?: GoalBuild };
export type GoalWindow = {
  recurrence: GoalRecurrence; startsOn: string; endsOn: string; tz: string; season: number | null;
  startsAt?: string | null; endsAt?: string | null;
};
export type GoalProgress = {
  state: "upcoming" | "active" | "met" | "ended";
  target: number;
  value: number | null;
  fraction: number;
  games: number;
  phase: "progress" | "sample";
  met: boolean;
  needed: number | null;
  minGames: number | null;
  wins?: number;
  losses?: number;
  peak?: number | null;
  first?: number | null;
  checkins?: number;
  noRatedGames?: boolean;
  current: { key: string; startsAt: string | null; endsAt: string | null } | null;
  buckets: { total: number; elapsed: number; met: number } | null;
};
export type Goal = {
  id: string;
  type: GoalType;
  params: GoalParams;
  filters: GoalFilters;
  window: GoalWindow;
  title: string | null;
  label: string;
  pinned: boolean;
  status: "active" | "completed";
  outcome: "met" | "missed" | null;
  completedAt: string | null;
  createdAt: string | null;
  progress: GoalProgress | null;
};
export type GoalsResponse = { goals: Goal[]; completed: Goal[]; limits: { maxActive: number; maxPinned: number } };
export type GoalInput = { type: GoalType; params: GoalParams; filters: GoalFilters; window: GoalWindow; title?: string | null };

export const GOAL_MIN_GAMES: Partial<Record<GoalType, { floor: number; fallback: number }>> = {
  win_rate: { floor: 20, fallback: 20 },
  macro_avg: { floor: 5, fallback: 10 },
  apm_avg: { floor: 5, fallback: 10 },
  sq_avg: { floor: 5, fallback: 10 },
};

export type GoalTemplate = {
  id: string;
  type: GoalType;
  title: string;
  description: string;
  target: number;
  recurrence: GoalRecurrence;
  unit: string;
  min: number;
  max: number;
  step: number;
};

/** The New goal modal's starting points. */
export const GOAL_TEMPLATES: readonly GoalTemplate[] = [
  { id: "volume", type: "games_played", title: "Play more games", description: "A number of games each week, day or month.", target: 30, recurrence: "weekly", unit: "games", min: 1, max: 1000, step: 1 },
  { id: "winrate", type: "win_rate", title: "Win rate", description: "Win a share of your decided games. Counts from 20 games.", target: 55, recurrence: "monthly", unit: "%", min: 1, max: 100, step: 1 },
  { id: "climb", type: "mmr_reach", title: "Reach an MMR", description: "Hit a rating from your replays, this season or by a date.", target: 4000, recurrence: "season", unit: "MMR", min: 1, max: 8000, step: 10 },
  { id: "macro", type: "macro_avg", title: "Macro score", description: "Average macro score across your games.", target: 70, recurrence: "weekly", unit: "macro", min: 1, max: 100, step: 1 },
  { id: "sq", type: "sq_avg", title: "Spending Quotient", description: "Average SQ: spend your money as you earn it.", target: 80, recurrence: "weekly", unit: "SQ", min: 1, max: 200, step: 1 },
  { id: "apm", type: "apm_avg", title: "APM", description: "Average actions per minute.", target: 150, recurrence: "weekly", unit: "APM", min: 1, max: 1000, step: 5 },
  { id: "build", type: "build_reps", title: "Practise a build", description: "Play one build a number of times. Check-ins count.", target: 10, recurrence: "weekly", unit: "games", min: 1, max: 1000, step: 1 },
] as const;

export const RECURRENCE_LABELS: Record<GoalRecurrence, string> = {
  once: "One window", daily: "Every day", weekly: "Every week", monthly: "Every month", season: "One ladder season",
};

/** Recurrences each type accepts (mirrors the API). */
export function recurrencesFor(type: GoalType): GoalRecurrence[] {
  return type === "mmr_reach" ? ["season", "once"] : ["weekly", "daily", "monthly", "season", "once"];
}

const DAY_MS = 86_400_000;

function serial(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function keyOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Example: `addDays("2026-11-30", 2)` → "2026-12-02". */
export function addDays(key: string, days: number): string {
  return keyOf(serial(key) + days * DAY_MS);
}

/** Monday of the local week containing `key`. */
export function mondayOf(key: string): string {
  const day = new Date(serial(key)).getUTCDay();
  return addDays(key, -((day + 6) % 7));
}

/** Last day of the month `months` after the one containing `key`. */
function monthEnd(key: string, months: number): string {
  const [y, m] = key.split("-").map(Number);
  return keyOf(Date.UTC(y, m + months, 1) - DAY_MS);
}

/**
 * The default inclusive local window for a new goal, so the current
 * period counts in full: this week from Monday, this month from the 1st.
 * Seasons take their dates from the season picker.
 *
 * Example: `defaultWindow("weekly", "2026-11-11")` →
 * {startsOn: "2026-11-09", endsOn: "2027-01-03"} (eight weeks).
 */
export function defaultWindow(recurrence: Exclude<GoalRecurrence, "season">, today: string): { startsOn: string; endsOn: string } {
  if (recurrence === "daily") return { startsOn: today, endsOn: addDays(today, 13) };
  if (recurrence === "weekly") { const monday = mondayOf(today); return { startsOn: monday, endsOn: addDays(monday, 8 * 7 - 1) }; }
  if (recurrence === "monthly") return { startsOn: `${today.slice(0, 7)}-01`, endsOn: monthEnd(today, 2) };
  return { startsOn: today, endsOn: addDays(today, 29) };
}

/** A season's inclusive local dates from its catalog boundaries. */
export function seasonWindow(start: string, end: string | null, tz: string): { startsOn: string; endsOn: string } {
  const startsOn = todayKeyIn(tz, new Date(start));
  // An open-ended current season is estimated at the usual ~3 months.
  const endsOn = end ? todayKeyIn(tz, new Date(Date.parse(end) - 1)) : addDays(startsOn, 90);
  return { startsOn, endsOn };
}

function fmt(value: number | null | undefined, digits = 0): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return formatNumber(value, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

const AVERAGE_UNIT: Partial<Record<GoalType, string>> = { macro_avg: "macro score", apm_avg: "APM", sq_avg: "SQ" };

/**
 * The progress line next to the bar.
 *
 * Example: games_played value 3 of 5 → "3 of 5 games".
 */
export function progressText(goal: Pick<Goal, "type" | "params" | "progress">): string {
  const p = goal.progress;
  const target = goal.params.target;
  if (!p) return "";
  switch (goal.type) {
    case "games_played":
    case "build_reps":
      return `${fmt(p.value)} of ${fmt(target)} games${goal.type === "build_reps" && p.checkins ? ` · ${p.checkins} by check-in` : ""}`;
    case "win_rate":
      return p.phase === "sample" ? `${p.games} of ${p.minGames ?? 20} decided games` : `${fmt(p.value, 1)}% won · target ${fmt(target)}%`;
    case "mmr_reach":
      return p.noRatedGames ? `Target ${fmt(target)} MMR` : `${fmt(p.value)} now · peak ${fmt(p.peak)} · target ${fmt(target)}`;
    default:
      return p.phase === "sample"
        ? `${p.games} of ${p.minGames ?? 5} games with ${AVERAGE_UNIT[goal.type] ?? "data"}`
        : `${fmt(p.value, 1)} average ${AVERAGE_UNIT[goal.type]} · target ${fmt(target)}`;
  }
}

/** The minimum-sample guard, or null once the measurement counts. */
export function sampleGuard(goal: Pick<Goal, "type" | "progress">): string | null {
  const p = goal.progress;
  if (!p || p.phase !== "sample") return null;
  if (goal.type === "mmr_reach") return p.noRatedGames ? "No rated games yet" : null;
  const more = p.needed ?? 0;
  if (more <= 0) return null;
  const noun = more === 1 ? "game" : "games";
  return goal.type === "win_rate" ? `${more} more ${noun} before this rate counts` : `${more} more ${noun} before this average counts`;
}

/** "This week", "Today", "This month", "Season 68" or the dated window. */
export function periodLabel(goal: Pick<Goal, "window" | "progress">, locale?: string): string {
  const w = goal.window;
  if (goal.progress?.state === "upcoming") return `Starts ${formatDay(w.startsOn, locale)}`;
  if (w.recurrence === "daily") return "Today";
  if (w.recurrence === "weekly") return "This week";
  if (w.recurrence === "monthly") return "This month";
  if (w.recurrence === "season") return `Season ${w.season}`;
  return `${formatDay(w.startsOn, locale)} – ${formatDay(w.endsOn, locale)}`;
}

/** A local date as "Nov 9". */
export function formatDay(key: string, locale?: string): string {
  const options = { month: "short", day: "numeric", timeZone: "UTC" } as const;
  return locale ? createFormatter({ ...SSR_FORMAT_PREFS, locale }).date(new Date(serial(key)), options) : formatDate(new Date(serial(key)), options);
}

/** Met periods of a recurring goal, e.g. "Met 3 of 5 weeks". */
export function streakText(goal: Pick<Goal, "window" | "progress">): string | null {
  const b = goal.progress?.buckets;
  if (!b || b.elapsed === 0) return null;
  const unit = goal.window.recurrence === "daily" ? "day" : goal.window.recurrence === "weekly" ? "week" : "month";
  return `Met ${b.met} of ${b.elapsed} ${unit}${b.elapsed === 1 ? "" : "s"}`;
}

const SECTION_FOR: Record<GoalType, string> = {
  games_played: "replays", win_rate: "trends", mmr_reach: "trends", macro_avg: "macro",
  apm_avg: "macro", sq_avg: "macro", build_reps: "builds",
};

/**
 * The analyzer section that lists the games behind a goal's current
 * period, filtered the way the goal counts them (ranked 1v1, matchup,
 * map, build, period dates).
 */
export function goalDeepLink(goal: Pick<Goal, "type" | "filters" | "params" | "window" | "progress">): string {
  const filters: Record<string, unknown> = {};
  const range = goal.progress?.current ?? { startsAt: goal.window.startsAt ?? null, endsAt: goal.window.endsAt ?? null };
  if (range.startsAt && range.endsAt) {
    filters.preset = "custom";
    filters.since = range.startsAt;
    filters.until = new Date(Date.parse(range.endsAt) - 1).toISOString();
  }
  if (goal.filters.ranked) { filters.map_pool = "ladder"; filters.game_size = "1v1"; } else filters.game_size = "1v1";
  if (goal.filters.matchup) { filters.race = goal.filters.matchup[0]; filters.opp_race = goal.filters.matchup[2]; }
  if (goal.filters.map) filters.map = goal.filters.map;
  if (goal.type === "build_reps" && goal.params.build) filters.build = goal.params.build.name;
  return analyzerViewHref({ section: SECTION_FOR[goal.type], filters: filters as AnalyzerFilters });
}

/** The goal as a sentence, for the modal's live preview (the API labels saved goals). */
export function previewLabel(input: GoalInput): string {
  const t = input.params.target;
  const scope = [input.filters.ranked ? "ranked" : "", input.filters.matchup ?? ""].filter(Boolean).join(" ");
  const games = scope ? `${scope} games` : "games";
  const on = input.filters.map ? ` on ${input.filters.map}` : "";
  const period = input.window.recurrence === "season" ? ` in Season ${input.window.season ?? "?"}`
    : input.window.recurrence === "daily" ? " each day" : input.window.recurrence === "weekly" ? " each week"
      : input.window.recurrence === "monthly" ? " each month" : "";
  const n = getServerFormatter().number(t);
  switch (input.type) {
    case "games_played": return `Play ${n} ${t === 1 ? games.replace(/games$/, "game") : games}${on}${period}`;
    case "win_rate": return `Win ${n}% of ${games}${on}${period}`;
    case "mmr_reach": return `Reach ${n} MMR${period}`;
    case "macro_avg": return `Average a ${n}+ macro score in ${games}${on}${period}`;
    case "apm_avg": return `Average ${n}+ APM in ${games}${on}${period}`;
    case "sq_avg": return `Average ${n}+ SQ in ${games}${on}${period}`;
    case "build_reps": return `Play ${input.params.build?.name ?? "a build"} ${n} time${t === 1 ? "" : "s"}${input.filters.matchup ? ` in ${input.filters.matchup}` : ""}${on}${period}`;
  }
}

/** Active goals for Today: pinned first, at most three. */
export function todayGoals(goals: readonly Goal[], limit = 3): Goal[] {
  return goals.filter((goal) => goal.pinned).slice(0, limit);
}

export const MATCHUPS = ["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ"] as const;
