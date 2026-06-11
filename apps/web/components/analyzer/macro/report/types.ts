/**
 * Wire types for GET /v1/macro/report — see
 * apps/api/src/services/macroReport.js (shapeReport) for the producer.
 * All rates are 0–1 fractions or null when the denominator is 0.
 */

export interface ScoreBucketRow {
  key: string;
  label: string;
  /** Inclusive lower bound; null = unbounded. */
  min: number | null;
  /** EXCLUSIVE upper bound; null = unbounded. Matches the API's
   *  macro_min/macro_max games-list filters so a bucket click lists
   *  exactly the games the bar counted. */
  max: number | null;
  games: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgScore: number | null;
}

export interface LeakTrend {
  /** Leak mineral cost per game over the NEWER half of the range. */
  currentPerGame: number | null;
  /** Same over the OLDER half. */
  previousPerGame: number | null;
  /** current − previous; negative = improving. */
  deltaPerGame: number | null;
}

export interface LeakRow {
  name: string;
  games: number;
  /** Fraction of scored games where this leak appeared. */
  share: number | null;
  totalMinerals: number;
  /** Minerals lost per AFFECTED game. */
  mineralsPerGame: number;
  avgPenalty: number | null;
  wins: number;
  losses: number;
  winRateWith: number | null;
  winRateWithout: number | null;
  trend: LeakTrend | null;
}

export interface SegmentRow {
  key: string;
  label: string;
  games: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgScore: number | null;
}

export interface ReportTrend {
  splitDate: string;
  currentGames: number;
  previousGames: number;
  currentAvgScore: number | null;
  previousAvgScore: number | null;
}

export interface MacroReportData {
  ok: boolean;
  gamesTotal: number;
  gamesScored: number;
  avgScore: number | null;
  winRate: number | null;
  scoreBuckets: ScoreBucketRow[];
  leaks: LeakRow[];
  segments: {
    matchup: SegmentRow[];
    duration: SegmentRow[];
    build: SegmentRow[];
  };
  trend: ReportTrend | null;
}

/**
 * A click-through from a report row into the games behind it. The
 * params land on /v1/games-list verbatim (leak / macro_min /
 * macro_max / opp_race / build — all parsed by the API's
 * parseFilters).
 */
export interface ReportDrill {
  title: string;
  description?: string;
  params: Record<string, string | number>;
}
