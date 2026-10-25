/** Scalar, owner-only summaries. Full macro/build logs stay behind game intent. */
export interface OpponentLatestGame {
  gameId: string;
  date: string;
  map: string | null;
  result: string | null;
  durationSec: number | null;
  myBuild: string | null;
  oppStrategy: string | null;
  buildPlanned?: boolean;
  detectedBuild?: string | null;
  oppStrategyPlanned?: boolean;
  detectedOppStrategy?: string | null;
  macroScore: number | null;
  top3Leaks: string[];
  replayAvailable: boolean;
  replaySizeBytes: number | null;
}
export interface OpponentListDetails {
  latestGame?: OpponentLatestGame | null;
  duration?: { sumSec: number; samples: number; averageSec: number | null };
  macro?: { sum: number; samples: number; average: number | null };
  latestOppBuildOrder?: { gameId: string; date: string } | null;
  opponentBuildOrderAvailability?: "known" | "unknown";
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function latest<T extends { gameId: string; date: string }>(rows: readonly (T | null | undefined)[]): T | null {
  return rows.filter((row): row is T => !!row?.gameId && Number.isFinite(Date.parse(row.date))).sort((a, b) =>
    Date.parse(b.date) - Date.parse(a.date) || (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0),
  )[0] ?? null;
}

/** Merged aliases need weighted samples and independently dated latest records. */
export function mergeOpponentListDetails(rows: readonly OpponentListDetails[]): OpponentListDetails {
  if (!rows.some(row => row.latestGame !== undefined || row.duration !== undefined || row.macro !== undefined || row.opponentBuildOrderAvailability !== undefined)) return {};
  let durationSum = 0, durationSamples = 0, macroSum = 0, macroSamples = 0;
  for (const row of rows) {
    if (row.duration && finite(row.duration.sumSec) && Number.isSafeInteger(row.duration.samples) && row.duration.samples > 0) {
      durationSum += row.duration.sumSec; durationSamples += row.duration.samples;
    }
    if (row.macro && finite(row.macro.sum) && Number.isSafeInteger(row.macro.samples) && row.macro.samples > 0 && row.macro.sum <= 100 * row.macro.samples) {
      macroSum += row.macro.sum; macroSamples += row.macro.samples;
    }
  }
  return {
    latestGame: latest(rows.map(row => row.latestGame)),
    duration: { sumSec: durationSum, samples: durationSamples, averageSec: durationSamples ? durationSum / durationSamples : null },
    macro: { sum: macroSum, samples: macroSamples, average: macroSamples ? macroSum / macroSamples : null },
    latestOppBuildOrder: latest(rows.map(row => row.latestOppBuildOrder)),
    opponentBuildOrderAvailability: rows.every(row => row.opponentBuildOrderAvailability === "known") ? "known" : "unknown",
  };
}
