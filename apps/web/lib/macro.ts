/**
 * Pure helpers shared between the MacroBreakdownPanel sub-components.
 *
 * The panel splits into KPI / penalty bars / leaks / chart, and each
 * piece needs the same derived facts (effective race, headline tone,
 * "wins" copy, penalty rows). Centralising the math here keeps the UI
 * components rendering-only.
 */

import type {
  BreakdownRaw,
  EffectiveRace,
  LeakItem,
  MacroBreakdownData,
  PenaltyRow,
  RaceMeta,
} from "@/components/analyzer/macro/MacroBreakdownPanel.types";

const RACE_DETAIL: Record<EffectiveRace, RaceMeta> = {
  Zerg: {
    title: "Inject Efficiency",
    actualKey: "injects_actual",
    expectedKey: "injects_expected",
    unitPlural: "injects",
    winCopy: "Inject cadence kept up with hatchery uptime.",
    penaltyLabel: "Inject penalty",
  },
  Protoss: {
    title: "Chrono Efficiency",
    actualKey: "chronos_actual",
    expectedKey: "chronos_expected",
    unitPlural: "chronos",
    winCopy: "Chrono usage matched nexus uptime.",
    penaltyLabel: "Chrono penalty",
  },
  Terran: {
    title: "MULE Efficiency",
    actualKey: "mules_actual",
    expectedKey: "mules_expected",
    unitPlural: "MULEs",
    winCopy: "MULE drops kept pace with orbital energy.",
    penaltyLabel: "MULE penalty",
  },
};

export function getRaceDetail(race: EffectiveRace | null): RaceMeta | null {
  if (!race) return null;
  return RACE_DETAIL[race];
}

/**
 * Resolve the effective race for a breakdown. The backend writes a
 * race tag when known; older / Random games fall back to the exclusive
 * discipline field that `analytics/macro_score.py` populates (only one
 * of injects/chronos/mules is non-null per game).
 */
export function computeEffectiveRace(
  race: string | null | undefined,
  raw: BreakdownRaw | undefined,
): EffectiveRace | null {
  if (race === "Zerg" || race === "Protoss" || race === "Terran") return race;
  if (!raw) return null;
  if (raw.injects_actual != null) return "Zerg";
  if (raw.chronos_actual != null) return "Protoss";
  if (raw.mules_actual != null) return "Terran";
  return null;
}

export type ScoreTone = "danger" | "warning" | "success" | "neutral";

export function scoreTone(score: number | null | undefined): ScoreTone {
  if (typeof score !== "number") return "neutral";
  if (score >= 75) return "success";
  if (score >= 50) return "warning";
  return "danger";
}

const TONE_TEXT_CLASS: Record<ScoreTone, string> = {
  danger: "text-danger",
  warning: "text-warning",
  success: "text-success",
  neutral: "text-text-dim",
};

export function scoreToneTextClass(score: number | null | undefined): string {
  return TONE_TEXT_CLASS[scoreTone(score)];
}

export type SqTier = "Pro" | "Master" | "Diamond" | "Platinum" | null;

/**
 * Spending Quotient → ladder-tier label. Mirrors the SPA's "Master"/
 * "Diamond" copy; the cutoffs match `analytics/macro_score.py`.
 */
export function tierFromSq(sq: number | null | undefined): SqTier {
  if (typeof sq !== "number" || !Number.isFinite(sq)) return null;
  if (sq >= 90) return "Pro";
  if (sq >= 80) return "Master";
  if (sq >= 70) return "Diamond";
  if (sq >= 60) return "Platinum";
  return null;
}

/**
 * Build "what you did well" callouts for the leaks panel. Each callout
 * is anchored to a backend signal so the copy never speculates.
 */
export function computeWins(
  raw: BreakdownRaw | undefined,
  detail: RaceMeta | null,
): string[] {
  const wins: string[] = [];
  if (!raw) return wins;
  if ((raw.supply_block_penalty || 0) <= 0) {
    wins.push("No meaningful supply block — production never stalled.");
  }
  if (detail && (raw.race_penalty || 0) <= 0) {
    wins.push(detail.winCopy);
  }
  if ((raw.float_penalty || 0) <= 0) {
    wins.push("Bank stayed under control — no sustained float.");
  }
  if (typeof raw.sq === "number") {
    if (raw.sq >= 80) {
      wins.push(
        `Spending Quotient ${raw.sq.toFixed(0)} — Master/Pro-tier macro pacing.`,
      );
    } else if (raw.sq >= 70) {
      wins.push(
        `Spending Quotient ${raw.sq.toFixed(0)} — solid Diamond-tier macro pacing.`,
      );
    }
  }
  return wins;
}

/**
 * Per-category penalty rows used by both the bar chart and the table.
 * `value` is the points lost (always rendered with a leading minus).
 */
export function computePenaltyRows(
  raw: BreakdownRaw | undefined,
  detail: RaceMeta | null,
): PenaltyRow[] {
  if (!raw) return [];
  const racePenaltyLabel = detail
    ? detail.penaltyLabel
    : "Race-mechanic penalty";
  return [
    {
      label: "Supply-block penalty",
      value: roundPoints(raw.supply_block_penalty),
      tone: (raw.supply_block_penalty || 0) > 0 ? "danger" : "success",
    },
    {
      label: racePenaltyLabel,
      value: roundPoints(raw.race_penalty),
      tone: (raw.race_penalty || 0) > 0 ? "danger" : "success",
    },
    {
      label: "Mineral-float penalty",
      value: roundPoints(raw.float_penalty),
      tone: (raw.float_penalty || 0) > 0 ? "danger" : "success",
    },
  ];
}

function roundPoints(v: number | null | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.round(v * 10) / 10;
}

/**
 * Pick the leak collection that drives the leaks panel + chart markers.
 * Prefers `all_leaks` (full breakdown), falls back to `top_3_leaks`.
 */
export function selectLeaks(data: MacroBreakdownData | null | undefined): LeakItem[] {
  if (!data) return [];
  if (Array.isArray(data.all_leaks) && data.all_leaks.length > 0) {
    return data.all_leaks;
  }
  if (Array.isArray(data.top_3_leaks)) return data.top_3_leaks;
  return [];
}

/**
 * Stable string id for a leak, used as the React key and the
 * highlighted-leak token. Uses time when available so two leaks of the
 * same name in different windows don't collide.
 */
export function leakKey(leak: LeakItem, idx: number): string {
  const name = (leak.name || "leak").replace(/\s+/g, "-").toLowerCase();
  const t = typeof leak.time === "number" ? Math.round(leak.time) : idx;
  return `${name}-${t}`;
}

/** Format `[m:ss]`-style game clock from a seconds value. */
export function formatGameClock(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const ss = (s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

/** True when the backend is missing the time-series chart inputs. */
export function isMissingChartSamples(data: MacroBreakdownData | null | undefined): boolean {
  if (!data) return true;
  const my = Array.isArray(data.stats_events) ? data.stats_events : [];
  const opp = Array.isArray(data.opp_stats_events)
    ? data.opp_stats_events
    : [];
  return my.length === 0 && opp.length === 0;
}
