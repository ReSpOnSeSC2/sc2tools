import { coerceRace, type Race } from "./race";
import type { CsvColumn } from "./csvExport";
import type { OpponentGroup } from "./opponentGroups";
import { notePreview, type Opp } from "@/components/analyzer/opponents/types";

export function opponentRace(value: unknown): Race | null {
  return typeof value === "string" && /^(p|protoss|t|terran|z|zerg|r|random)$/i.test(value.trim()) ? coerceRace(value) : null;
}
export function opponentRegion(row: Pick<Opp, "region" | "toonHandle" | "pulseId">): string | null {
  if (row.region && /^(NA|US|EU|KR|CN|PTR)$/i.test(row.region)) return row.region.toUpperCase() === "US" ? "NA" : row.region.toUpperCase();
  const code = (row.toonHandle || row.pulseId).match(/^(1|2|3|5|98)-/u)?.[1];
  return code ? ({ "1": "NA", "2": "EU", "3": "KR", "5": "CN", "98": "PTR" }[code] || null) : null;
}
export const OPPONENT_EXTRA_COLUMNS = [
  { key: "pulseId", label: "Pulse ID", group: "Identity and rating" },
  { key: "mmr", label: "Last MMR", group: "Identity and rating" },
  { key: "netMmr", label: "Net MMR", group: "Identity and rating" },
  { key: "mmrWon", label: "MMR won", group: "Identity and rating" },
  { key: "mmrLost", label: "MMR lost", group: "Identity and rating" },
  { key: "region", label: "Region", group: "Identity and rating" },
  { key: "latestReplay", label: "Download latest replay", group: "Latest game" },
  { key: "lastResult", label: "Last result", group: "Latest game" },
  { key: "lastGameLength", label: "Last game length", group: "Latest game" },
  { key: "map", label: "Last map", group: "Latest game" },
  { key: "myBuild", label: "My build", group: "Builds and orders" },
  { key: "opponentBuild", label: "Opponent build", group: "Builds and orders" },
  { key: "opponentBuildOrder", label: "Opponent build order", group: "Builds and orders" },
  { key: "buildOrderDate", label: "Last recorded build order date", group: "Builds and orders" },
  { key: "macroBreakdown", label: "My latest macro breakdown", group: "Performance" },
  { key: "topMacroLeaks", label: "My latest macro leaks", group: "Performance" },
  { key: "avgGameLength", label: "Average game length", group: "Performance" },
  { key: "avgMacroScore", label: "My average macro score", group: "Performance" },
  { key: "notes", label: "Scouting notes", group: "Notes" },
] as const;
export type OpponentColumnKey = typeof OPPONENT_EXTRA_COLUMNS[number]["key"];
type OriginalColumn = "pulseId" | "mmr" | "netMmr" | "mmrWon" | "mmrLost";
export type OpponentColumns = Record<OriginalColumn, boolean> & Partial<Record<Exclude<OpponentColumnKey, OriginalColumn>, boolean>>;
export const OPPONENT_DETAIL_COLUMNS = OPPONENT_EXTRA_COLUMNS.filter(column => !["pulseId", "mmr", "netMmr", "mmrWon", "mmrLost"].includes(column.key));
export const OPPONENT_DETAIL_SORT_KEYS = new Set(["region", "lastResult", "lastGameLength", "avgGameLength", "map", "myBuild", "opponentBuild", "macroBreakdown", "avgMacroScore", "buildOrderDate"]);
export function opponentDetailSortValue(row: Opp, key: string): unknown {
  switch (key) {
    case "region": return opponentRegion(row);
    case "lastResult": return row.latestGame?.result;
    case "lastGameLength": return row.latestGame?.durationSec;
    case "avgGameLength": return row.duration?.averageSec;
    case "map": return row.latestGame?.map;
    case "myBuild": return row.latestGame?.myBuild;
    case "opponentBuild": return row.latestGame?.oppStrategy;
    case "macroBreakdown": return row.latestGame?.macroScore;
    case "avgMacroScore": return row.macro?.average;
    case "buildOrderDate": {
      const time = Date.parse(row.latestOppBuildOrder?.date || "");
      return Number.isFinite(time) ? time : null;
    }
    default: return (row as unknown as Record<string, unknown>)[key];
  }
}
/** Unknown future boolean choices can coexist without discarding known choices. */
export function isOpponentColumnOverrides(value: unknown): value is Partial<OpponentColumns> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length <= 64
    && Object.values(value).every(visible => typeof visible === "boolean");
}
export function opponentColumns(overrides: Partial<OpponentColumns>, verified: boolean): OpponentColumns {
  const out: OpponentColumns = { pulseId: false, mmr: verified, netMmr: verified, mmrWon: false, mmrLost: false };
  for (const { key } of OPPONENT_EXTRA_COLUMNS) out[key] = typeof overrides[key] === "boolean" ? overrides[key] : out[key] ?? false;
  return out;
}
export function opponentListDetailsSelected(columns: OpponentColumns): boolean {
  return OPPONENT_DETAIL_COLUMNS.some(column => column.key !== "region" && column.key !== "notes" && columns[column.key]);
}
export const OPPONENT_CSV_COLUMNS: CsvColumn<OpponentGroup<Opp>>[] = [
  { key: "name", label: "Name" }, { key: "revealedName", label: "Revealed name" }, { key: "race", label: "Race" },
  { key: "pulseCharacterId", label: "Pulse ID" }, { key: "toonHandle", label: "Toon handle" },
  { key: "wins", label: "Wins" }, { key: "losses", label: "Losses" }, { key: "winRate", label: "Win rate" }, { key: "games", label: "Games" },
  { key: "mmr", label: "Last MMR" }, { key: "netMmr", label: "Net MMR" },
  { key: "mmrWon", label: "MMR won", format: (value, row) => row.mmrPairs ? value as number : null },
  { key: "mmrLost", label: "MMR lost", format: (value, row) => row.mmrPairs ? value as number : null },
  { key: "lastPlayed", label: "Last played", format: value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null },
  { key: "notes", label: "Notes preview", format: (_value, row) => row.identities.map(notePreview).filter(Boolean).join(" | ") },
  { key: "pulseId", label: "Merged accounts", format: (_value, row) => row.identities.map(item => item.toonHandle || item.pulseId).join(" | ") },
];

/** Optional scalar columns only; never export signed URLs or full replay logs. */
export const OPPONENT_DETAIL_CSV_COLUMNS: CsvColumn<OpponentGroup<Opp>>[] = [
  { key: "latestGameDate", label: "Latest game date", format: (_value, row) => row.latestGame?.date },
  { key: "latestReplayAvailable", label: "Latest replay archived", format: (_value, row) => row.latestGame?.replayAvailable },
  { key: "lastResult", label: "Last result", format: (_value, row) => row.latestGame?.result },
  { key: "lastGameLength", label: "Last game length (seconds)", format: (_value, row) => row.latestGame?.durationSec },
  { key: "averageGameLength", label: "Average game length (seconds)", format: (_value, row) => row.duration?.averageSec },
  { key: "durationSamples", label: "Games with measured length", format: (_value, row) => row.duration?.samples },
  { key: "lastMap", label: "Last map", format: (_value, row) => row.latestGame?.map },
  { key: "myBuild", label: "My latest build", format: (_value, row) => row.latestGame?.myBuild },
  { key: "opponentBuild", label: "Latest opponent build", format: (_value, row) => row.latestGame?.oppStrategy },
  { key: "lastMacroScore", label: "My latest macro score", format: (_value, row) => row.latestGame?.macroScore },
  { key: "averageMacroScore", label: "My average macro score", format: (_value, row) => row.macro?.average },
  { key: "macroSamples", label: "Games with measured macro", format: (_value, row) => row.macro?.samples },
  { key: "macroLeaks", label: "My latest macro leaks", format: (_value, row) => row.latestGame?.top3Leaks?.join(" | ") },
  { key: "opponentOrderDate", label: "Last known opponent build order date", format: (_value, row) => row.latestOppBuildOrder?.date },
  { key: "orderDateCoverage", label: "Opponent order indexing", format: (_value, row) => row.opponentBuildOrderAvailability },
];
