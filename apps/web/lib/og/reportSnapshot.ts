import type { StatsEvent } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import { battleReportFacts } from "@/lib/battleReport/facts";
import { planBattleReport, type BattleReport } from "@/lib/battleReport/plan";
import { sharedReportInput, type SharedGameAnalysis } from "@/lib/sharedGame";

/**
 * The link-preview version of a shared game's battle report: the same
 * headline the share page shows (same share-safe input, same seed) and the
 * turning point as two army-value polylines, ready for an SVG in a Satori
 * card. Server-side only in the sense of where it runs: no endpoint,
 * model or extra request; it reads the payload the card already loaded.
 */
export interface ReportPreview {
  headline: string;
  turningPoint: { time: number; caption: string; mine: string; opponent: string; marker: number } | null;
}

/** Chart box of the preview snapshot, in SVG user units. */
export const SNAPSHOT_BOX = { width: 360, height: 150 } as const;

export function reportPreview(data: SharedGameAnalysis, token: string): ReportPreview {
  const report = planBattleReport(battleReportFacts(sharedReportInput(data, `share-${token}`)), "battle");
  return { headline: report.headline, turningPoint: turningPointSnapshot(report, data) };
}

function turningPointSnapshot(report: BattleReport, data: SharedGameAnalysis): ReportPreview["turningPoint"] {
  const swing = report.facts.story.turningPoints.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.time - b.time)[0];
  const moment = swing ? { time: swing.time, caption: "Turning point" }
    : report.facts.moments.find((row) => row.id === "largest-fight" || row.id === "first-clash");
  if (!moment) return null;
  const from = Math.max(0, moment.time - 90), until = Math.max(from + 1, moment.time + 90);
  const pick = (rows: readonly StatsEvent[] | null | undefined) => (rows ?? [])
    .filter((row) => known(row.time) && row.time >= from && row.time <= until && known(row.army_value))
    .sort((a, b) => a.time - b.time);
  const mine = pick(data.macroBreakdown?.stats_events), opponent = pick(data.macroBreakdown?.opp_stats_events);
  if (mine.length < 2 && opponent.length < 2) return null;
  const maximum = Math.max(1, ...[...mine, ...opponent].map((row) => row.army_value as number));
  const x = (t: number) => (t - from) / (until - from) * SNAPSHOT_BOX.width;
  const y = (v: number) => SNAPSHOT_BOX.height - 6 - v / maximum * (SNAPSHOT_BOX.height - 12);
  const path = (rows: StatsEvent[]) => rows.map((row, index) => `${index ? "L" : "M"}${x(row.time).toFixed(1)},${y(row.army_value as number).toFixed(1)}`).join(" ");
  return { time: moment.time, caption: moment.caption, mine: path(mine), opponent: path(opponent), marker: x(moment.time) };
}

function known(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
