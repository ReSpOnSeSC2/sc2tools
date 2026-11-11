/**
 * The /try report's local filters: opponent race, result and recency.
 * They slice the parsed games already held in memory (nothing is
 * re-parsed or sent anywhere), and the report is rebuilt from the slice,
 * so every card and the game list follow the same games.
 *
 * Matchup and result apply first; recency then keeps the newest 10 / 25
 * of what is left, or the games of the last 90 days. A game whose
 * opponent race is unknown, or that was not decided, only counts under
 * "All".
 *
 * Example:
 *   filterPayloads(payloads, { matchup: "Z", result: "all", recency: "25" }, new Date());
 */
import { outcome } from "@/components/analyzer/arcade/ArcadeEngine";
import type { InstantPayload } from "./reportPayload";

export type ReportMatchupFilter = "all" | "P" | "T" | "Z";
export type ReportResultFilter = "all" | "win" | "loss";
export type ReportRecencyFilter = "all" | "10" | "25" | "90d";

export interface ReportFilters {
  matchup: ReportMatchupFilter;
  result: ReportResultFilter;
  recency: ReportRecencyFilter;
}

export const DEFAULT_REPORT_FILTERS: Readonly<ReportFilters> = Object.freeze({ matchup: "all", result: "all", recency: "all" });
/** sessionStorage key; the preference lasts for the browser tab only. */
export const REPORT_FILTERS_STORAGE_KEY = "sc2tools.try.reportFilters.v1";
export const RECENT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

const MATCHUPS: ReadonlyArray<ReportMatchupFilter> = ["all", "P", "T", "Z"];
const RESULTS: ReadonlyArray<ReportResultFilter> = ["all", "win", "loss"];
const RECENCIES: ReadonlyArray<ReportRecencyFilter> = ["all", "10", "25", "90d"];
const RACE_WORDS: Readonly<Record<"P" | "T" | "Z", string>> = { P: "Protoss", T: "Terran", Z: "Zerg" };

/** "Protoss" for "P". */
export function raceWord(race: "P" | "T" | "Z"): string {
  return RACE_WORDS[race];
}

/**
 * The opponent's race letter, or null when the replay did not name a
 * playable race (Random stays unknown: the recap splits only P/T/Z).
 *
 * Example:
 *   opponentRaceLetter(bare({ opponent: { ...opp, race: "Zerg" } })); // -> "Z"
 */
export function opponentRaceLetter(payload: InstantPayload): "P" | "T" | "Z" | null {
  const first = payload.opponent?.race?.trim().charAt(0).toUpperCase() ?? "";
  return first === "P" || first === "T" || first === "Z" ? first : null;
}

/** Opponent races present in the games, in P/T/Z order (for the matchup chips). */
export function presentOpponentRaces(payloads: ReadonlyArray<InstantPayload>): Array<"P" | "T" | "Z"> {
  const seen = new Set(payloads.map(opponentRaceLetter));
  return (["P", "T", "Z"] as const).filter((race) => seen.has(race));
}

function datedUnique(payloads: ReadonlyArray<InstantPayload>): Array<{ payload: InstantPayload; time: number }> {
  const seen = new Set<string>();
  const rows: Array<{ payload: InstantPayload; time: number }> = [];
  for (const payload of payloads) {
    const time = Date.parse(payload.date);
    if (seen.has(payload.gameId) || !Number.isFinite(time)) continue;
    seen.add(payload.gameId);
    rows.push({ payload, time });
  }
  return rows;
}

function matchesResult(payload: InstantPayload, result: ReportResultFilter): boolean {
  if (result === "all") return true;
  return outcome({ result: payload.result }) === (result === "win" ? "W" : "L");
}

/**
 * The games the filters keep (duplicates and undated games dropped, as
 * the report itself does). Order is preserved apart from that.
 *
 * Example:
 *   filterPayloads(payloads, DEFAULT_REPORT_FILTERS, now).length; // -> every dated game
 */
export function filterPayloads(
  payloads: ReadonlyArray<InstantPayload>,
  filters: ReportFilters,
  now: Date,
): InstantPayload[] {
  let rows = datedUnique(payloads).filter(({ payload }) =>
    (filters.matchup === "all" || opponentRaceLetter(payload) === filters.matchup) && matchesResult(payload, filters.result));
  if (filters.recency === "10" || filters.recency === "25") {
    const keep = Number(filters.recency);
    const newest = [...rows]
      .sort((a, b) => b.time - a.time || a.payload.gameId.localeCompare(b.payload.gameId))
      .slice(0, keep);
    const kept = new Set(newest.map((row) => row.payload));
    rows = rows.filter((row) => kept.has(row.payload));
  } else if (filters.recency === "90d") {
    const since = now.getTime() - RECENT_DAYS * DAY_MS;
    rows = rows.filter((row) => row.time >= since);
  }
  return rows.map((row) => row.payload);
}

export function isFiltered(filters: ReportFilters): boolean {
  return filters.matchup !== "all" || filters.result !== "all" || filters.recency !== "all";
}

/**
 * Short description of the active filters, or null when none is set.
 *
 * Example:
 *   reportFilterLabel({ matchup: "Z", result: "all", recency: "25" }); // -> "vs Z · last 25 games"
 */
export function reportFilterLabel(filters: ReportFilters): string | null {
  const parts: string[] = [];
  if (filters.matchup !== "all") parts.push(`vs ${filters.matchup}`);
  if (filters.result !== "all") parts.push(filters.result === "win" ? "wins" : "losses");
  if (filters.recency === "10" || filters.recency === "25") parts.push(`last ${filters.recency} games`);
  else if (filters.recency === "90d") parts.push(`last ${RECENT_DAYS} days`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Any stored or hand-edited value becomes a valid filter set. */
export function parseReportFilters(raw: unknown): ReportFilters {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pick = <T extends string>(options: ReadonlyArray<T>, candidate: unknown): T =>
    options.find((option) => option === candidate) ?? options[0];
  return { matchup: pick(MATCHUPS, value.matchup), result: pick(RESULTS, value.result), recency: pick(RECENCIES, value.recency) };
}

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The tab's saved filters; the defaults when storage is blocked, empty or corrupt. */
export function loadReportFilters(): ReportFilters {
  try {
    const raw = sessionStore()?.getItem(REPORT_FILTERS_STORAGE_KEY);
    return raw ? parseReportFilters(JSON.parse(raw)) : { ...DEFAULT_REPORT_FILTERS };
  } catch {
    return { ...DEFAULT_REPORT_FILTERS };
  }
}

/** Remember the filters for this tab; a blocked store is ignored. */
export function saveReportFilters(filters: ReportFilters): void {
  try {
    const store = sessionStore();
    if (!store) return;
    if (isFiltered(filters)) store.setItem(REPORT_FILTERS_STORAGE_KEY, JSON.stringify(parseReportFilters(filters)));
    else store.removeItem(REPORT_FILTERS_STORAGE_KEY);
  } catch {
    // Private mode / blocked site data: the filters still work for this view.
  }
}
