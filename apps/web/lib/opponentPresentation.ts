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
export type OpponentColumns = { pulseId: boolean; mmr: boolean; netMmr: boolean; mmrWon: boolean; mmrLost: boolean };
export function opponentColumns(overrides: Partial<OpponentColumns>, verified: boolean): OpponentColumns {
  return { pulseId: false, mmr: verified, netMmr: verified, mmrWon: false, mmrLost: false, ...overrides };
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
