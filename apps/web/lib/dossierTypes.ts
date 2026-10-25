import type { H2HGame } from "./h2hSeries";

/** Dates are document metadata; the newest-first row sample is independently bounded. */
export type DossierSeriesData = { games: H2HGame[]; firstSeen?: string | null; lastSeen?: string | null; sourceLimit: number; truncated: boolean };
export type ScoutingBriefProfile = {
  pulseId?: string; name?: string; firstSeen?: string | null; lastSeen?: string | null;
  totals?: { wins: number; losses: number; total: number; winRate: number };
  byMap?: Record<string, { wins: number; losses: number }>;
  byStrategy?: Record<string, { wins: number; losses: number }>;
  predictedStrategies?: { strategy: string; probability: number }[];
  games?: H2HGame[]; gamesTruncated?: boolean; series?: DossierSeriesData;
  phases?: { finalPhaseDistribution?: Record<string, number> };
};
export type DossierTimingSource = "build_log" | "opp_build_log";
export type DossierTimingRow = {
  sampleCount?: number; count?: number; medianSeconds?: number | null; median?: number | null; medianDisplay?: string;
  p25Seconds?: number | null; p75Seconds?: number | null; p25Display?: string; p75Display?: string;
  lastSeenSeconds?: number | null; lastSeenDisplay?: string; winRateWhenBuilt?: number | null;
  trend?: "unknown" | "stable" | "later" | "earlier"; source?: DossierTimingSource;
  displayName?: string; iconFile?: string; samples?: { gameId?: string | number | null; date?: string | Date }[];
};
export type DossierTimingBucket = { timings: Record<string, DossierTimingRow>; order?: string[] };
export type DossierAnalysis = {
  medianTimings?: Record<string, DossierTimingRow>; medianTimingsLegacy?: Record<string, DossierTimingRow>; medianTimingsOrder?: string[];
  matchupTimings?: Record<string, DossierTimingBucket | Record<string, DossierTimingRow>>; matchupTimingsLegacy?: Record<string, DossierTimingBucket>; matchupCounts?: Record<string, number>;
  analysisSampleSize?: number; analysisSampleLimit?: number; analysisSampleTruncated?: boolean;
  buildOrdersAvailable?: number; yourBuildOrdersAvailable?: number; buildOrdersTotal?: number;
  analyzedGameIds?: string[]; analysisCohortSize?: number; gamesTruncated?: boolean;
};
export type TimingHistoryFilter = { token: string; label: string; source: DossierTimingSource; matchup?: string; gameIds: string[] };
