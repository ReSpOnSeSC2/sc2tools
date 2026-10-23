import { describeRule } from "./build-rules-copy";
import type { BuildRule } from "./build-rules";
import { encodeSaltDetailed, type SaltKind } from "./salt";

export interface ExportStep {
  time: number;
  name: string;
  display?: string;
  category?: string;
  supply?: number;
  supplyApprox?: boolean;
  count?: number;
}
export interface BuildExportMeta { title: string; matchup?: string; author?: string | null; sourceUrl: string; timing?: "deadlines" }
type SupplySample = { time: number; food_used?: number };
type StatsSample = SupplySample & { food_made?: number; food_workers?: number; minerals_current?: number; vespene_current?: number; minerals_collection_rate?: number; vespene_collection_rate?: number; army_value?: number };
type Casualty = { time: number; owner?: string; killer?: string | null; category?: string; name?: string; count?: number; minerals?: number; gas?: number };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clock = (time: number) => `${Math.floor(Math.max(0, time) / 60)}:${String(Math.floor(Math.max(0, time) % 60)).padStart(2, "0")}`;
const cleanLine = (value: string) => value.replace(/[\r\n\t]+/g, " ").trim();
const nameOf = (step: ExportStep) => `${step.count && step.count > 1 ? `${step.count}× ` : ""}${cleanLine(step.display || step.name)}`;
const supplyOf = (step: ExportStep) => finite(step.supply) && step.supply >= 0 ? `${step.supplyApprox ? "≈" : ""}${step.supply}` : "—";
const ordered = (steps: readonly ExportStep[]) => steps.filter(step => finite(step.time) && step.time >= 0 && nameOf(step)).slice().sort((a, b) => a.time - b.time);
const header = (meta: BuildExportMeta) => [cleanLine(meta.title), cleanLine(meta.matchup || "Any matchup"), `by ${cleanLine(meta.author || "Anonymous")}`].join(" · ");

/** Fallback for older APIs. Exact event supply wins; future samples are never used. */
export function withBuildSupply<T extends ExportStep>(events: readonly T[], samples?: readonly SupplySample[] | null): Array<T & Pick<ExportStep, "supply" | "supplyApprox">> {
  const stats = (samples || []).filter(row => finite(row.time) && row.time >= 0 && finite(row.food_used) && row.food_used >= 0).slice().sort((a, b) => a.time - b.time);
  return events.map(event => {
    if (finite(event.supply) && event.supply >= 0) return { ...event };
    let low = 0, high = stats.length - 1, prior = -1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (stats[middle].time <= event.time) { prior = middle; low = middle + 1; } else high = middle - 1;
    }
    return prior < 0 ? { ...event } : { ...event, supply: stats[prior].food_used, supplyApprox: true };
  });
}

export function buildToText(steps: readonly ExportStep[], meta: BuildExportMeta, mode: "clock" | "supply-clock" = "clock", rules: readonly BuildRule[] = []): string {
  const lines = ordered(steps).map(step => mode === "clock" ? `[${clock(step.time)}] ${supplyOf(step)} ${nameOf(step)}` : `${supplyOf(step)} ${nameOf(step)} [${clock(step.time)}]`);
  if (!lines.length) lines.push(...rules.map(rule => cleanLine(describeRule(rule))));
  return [header(meta), "", ...(meta.timing === "deadlines" ? ["Signature times are deadlines, not recorded production times.", ""] : []), ...lines, "", meta.sourceUrl].join("\n");
}

const markdown = (text: string) => cleanLine(text).replace(/([\\`*_\[\]<>|])/g, "\\$1");
export function buildToMarkdownTable(steps: readonly ExportStep[], meta: BuildExportMeta, rules: readonly BuildRule[] = []): string {
  const rows = ordered(steps);
  const body = rows.length ? ["| Time | Supply | Step |", "| --- | --- | --- |", ...rows.map(step => `| ${clock(step.time)} | ${supplyOf(step)} | ${markdown(nameOf(step))} |`)] : rules.map(rule => `- ${markdown(describeRule(rule))}`);
  return [`# ${markdown(meta.title)}`, `${markdown(meta.matchup || "Any matchup")} · by ${markdown(meta.author || "Anonymous")}`, "", ...(meta.timing === "deadlines" ? ["Signature times are deadlines, not recorded production times.", ""] : []), ...body, "", meta.sourceUrl].join("\n");
}

/** Avoid the encoder's legacy clamping: out-of-range data is explicitly skipped. */
export function buildToSalt(steps: readonly ExportStep[], meta: BuildExportMeta) {
  const skipped: string[] = [];
  const usable = ordered(steps).filter(step => {
    const reason = step.time > 5699 ? "time exceeds 94:59" : finite(step.supply) && (step.supply < 5 || step.supply > 98) ? "supply is outside 5–98" : step.count != null && (!finite(step.count) || step.count < 1 || step.count > 200 || !Number.isInteger(step.count)) ? "count is outside 1–200 whole steps" : null;
    if (reason) skipped.push(`${nameOf(step)} — ${reason}`);
    return !reason;
  });
  const result = encodeSaltDetailed(`${meta.title} · ${meta.matchup || "Any matchup"}`, usable.flatMap(step => Array.from({ length: Math.min(200, Math.max(1, Math.floor(step.count || 1))) }, () => ({
    name: step.name, timeSec: step.time, supply: step.supply ?? NaN,
    kind: (step.category === "building" ? "structure" : step.category === "upgrade" ? "upgrade" : "unit") as SaltKind,
  }))), { author: meta.author || "Anonymous", description: meta.sourceUrl });
  return { salt: result.salt, skipped: [...skipped, ...result.skipped] };
}

/** Text cells are spreadsheet-safe, including names imported from a replay. */
function csvCell(value: unknown): string {
  if (value == null || typeof value === "number" && !Number.isFinite(value)) return "";
  const raw = String(value);
  const text = typeof value === "string" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
const csv = (rows: readonly (readonly unknown[])[]) => rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
export function statsToCsv(me: readonly StatsSample[] = [], opp: readonly StatsSample[] = []): string {
  const rows = ([...me.map(row => ({ ...row, side: "you" })), ...opp.map(row => ({ ...row, side: "opponent" }))]).sort((a, b) => a.time - b.time);
  return csv([["time", "side", "supply_used", "supply_cap", "workers", "bank_minerals", "bank_gas", "income_minerals", "income_gas", "army_value"], ...rows.map(row => [row.time, row.side, row.food_used, row.food_made, row.food_workers, row.minerals_current, row.vespene_current, row.minerals_collection_rate, row.vespene_collection_rate, row.army_value])]);
}
export function casualtiesToCsv(events: readonly Casualty[] = []): string {
  return csv([["time", "owner", "killer", "category", "name", "count", "minerals", "gas"], ...events.slice().sort((a, b) => a.time - b.time).map(row => [row.time, row.owner, row.killer, row.category, row.name, row.count, row.minerals, row.gas])]);
}
export function gameToJson(data: { game: unknown; buildOrders?: unknown; macroBreakdown?: unknown }): string {
  return JSON.stringify({ schemaVersion: 1, game: data.game, buildOrders: data.buildOrders, macroBreakdown: data.macroBreakdown }, null, 2) + "\n";
}
export function gameExportFilename(date?: string | null, matchup?: string | null, map?: string | null): string {
  const safe = (text: string) => text.normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
  return `sc2tools-${safe(date?.slice(0, 10) || "undated")}-${safe(matchup || "unknown")}-${safe(map || "unknown")}`;
}
