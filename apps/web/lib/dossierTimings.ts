import type { DossierAnalysis, DossierTimingRow, DossierTimingSource, TimingHistoryFilter } from "./dossierTypes";

export type VisibleTiming = { token: string; row: DossierTimingRow; median: number; n: number; selection: TimingHistoryFilter | null };
const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Compatibility numbers never replace rich legacy rows' quartiles/source/sample IDs. */
export function visibleDossierTimings(data: DossierAnalysis, matchup: string, source: DossierTimingSource): VisibleTiming[] {
  const modern = matchup ? data.matchupTimings?.[matchup] : null, legacy = matchup ? data.matchupTimingsLegacy?.[matchup] : null;
  const modernBucket = modern && "timings" in modern ? modern as import("./dossierTypes").DossierTimingBucket : null;
  const rows = modernBucket?.timings ?? (modern as Record<string, DossierTimingRow> | undefined) ?? (matchup ? {} : data.medianTimings ?? {}), old = legacy?.timings ?? (matchup ? {} : data.medianTimingsLegacy ?? {});
  const order = [...new Set([...(modernBucket?.order ?? legacy?.order ?? data.medianTimingsOrder ?? []), ...Object.keys(rows), ...Object.keys(old)])];
  return order.flatMap(token => {
    const row = { ...old[token], ...rows[token] }, n = row.sampleCount ?? row.count, median = row.medianSeconds ?? row.median;
    if (row.source !== source || !valid(n) || n < 2 || !valid(median)) return [];
    const gameIds = [...new Set((row.samples ?? []).slice(0, 100).flatMap(sample => {
      const id = typeof sample.gameId === "string" ? sample.gameId : typeof sample.gameId === "number" && Number.isFinite(sample.gameId) ? String(sample.gameId) : "";
      return id && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id) ? [id] : [];
    }))];
    const selection = gameIds.length ? { token, label: row.displayName || token, source, ...(matchup ? { matchup } : {}), gameIds } : null;
    return [{ token, row, median, n: Math.floor(n), selection }];
  }).slice(0, 100);
}

export function timingDisplay(value: number | null | undefined, display?: string): string {
  if (display) return display;
  if (!valid(value)) return "Unavailable";
  const seconds = Math.floor(value); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
