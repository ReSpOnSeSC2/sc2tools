import { BUILD_DEFINITIONS } from "@/lib/build-definitions";
import type { InstantReport } from "./report";

export const REPORT_SHARE_URL = "https://sc2tools.com/try?utm_source=report&utm_medium=share&utm_campaign=instant";
export interface ReportSelection { totals: boolean; matchups: string[]; opener: boolean; macro: boolean }
export interface ReportCardModel {
  totals: { games: number; wins: number; losses: number } | null;
  matchups: Array<{ label: string; wins: number; losses: number }>;
  opener: { name: string; games: number; wins: number; losses: number } | null;
  macro: { score: number; games: number } | null;
}

const catalogNames = new Set(BUILD_DEFINITIONS.flatMap((row) => [row.name, row.eightWorkerName].filter((name): name is string => !!name)));
const count = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Allowlist aggregate fields only. Never copy game, player or account objects. */
export function reportCardModel(report: InstantReport, selection?: ReportSelection): ReportCardModel {
  const totals = report.totals;
  const rows = (report.recordByMatchup ?? []).filter((row) => /^[PTZ]$/.test(row.oppRace) && count(row.wins) && count(row.losses));
  const best = (report.openers ?? []).filter((row) => catalogNames.has(row.name) && row.games >= 3 && count(row.games)
    && count(row.wins) && count(row.losses) && row.wins + row.losses > 0 && row.wins + row.losses <= row.games)
    .sort((a, b) => b.wins / (b.wins + b.losses) - a.wins / (a.wins + a.losses) || b.games - a.games || a.name.localeCompare(b.name))[0];
  const macro = report.macro;
  return {
    totals: selection?.totals !== false && count(totals.games) && count(totals.wins) && count(totals.losses)
      && totals.wins + totals.losses <= totals.games ? { games: totals.games, wins: totals.wins, losses: totals.losses } : null,
    matchups: rows.filter((row) => !selection || selection.matchups.includes(row.oppRace)).slice(0, 3)
      .map((row) => ({ label: `vs ${row.oppRace}`, wins: row.wins, losses: row.losses })),
    opener: selection?.opener !== false && best ? { name: best.name, games: best.games, wins: best.wins, losses: best.losses } : null,
    macro: selection?.macro !== false && macro && macro.games > 0 && count(macro.games) && macro.averageScore !== null
      && Number.isFinite(macro.averageScore) && macro.averageScore >= 0 && macro.averageScore <= 100
      ? { score: Math.round(macro.averageScore), games: macro.games } : null,
  };
}

export function defaultReportSelection(model: ReportCardModel): ReportSelection {
  return { totals: !!model.totals, matchups: model.matchups.map((row) => row.label.slice(-1)), opener: !!model.opener, macro: !!model.macro };
}

export function reportCardText(model: ReportCardModel): string {
  return ["My StarCraft II replay report", model.totals ? `${model.totals.games} games · ${model.totals.wins}W ${model.totals.losses}L` : null,
    ...model.matchups.map((row) => `${row.label}: ${row.wins}W ${row.losses}L`),
    model.opener ? `Best opener: ${model.opener.name} · ${model.opener.wins}W ${model.opener.losses}L (${model.opener.games} games)` : null,
    model.macro ? `Macro score: ${model.macro.score}/100 (${model.macro.games} measured games)` : null,
    REPORT_SHARE_URL].filter(Boolean).join("\n");
}
