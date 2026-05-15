// Shared TS types for the snapshot drilldown surface. Mirror the
// /v1/snapshots/* response envelopes the API ships — keeping them
// here (rather than duplicated in each component) means a contract
// change is one file's worth of work and not 13.

export type SnapshotScope = "mine" | "community" | "both";

export type SnapshotVerdict =
  | "winning"
  | "likely_winning"
  | "neutral"
  | "likely_losing"
  | "losing"
  | "unknown";

export interface BandRow {
  p25w: number;
  p50w: number;
  p75w: number;
  p90w: number;
  p25l: number;
  p50l: number;
  p75l: number;
  p90l: number;
  sampleWinners: number;
  sampleLosers: number;
}

export type MetricKey =
  | "army_value"
  | "army_supply"
  | "workers"
  | "bases"
  | "production_capacity"
  | "income_min"
  | "income_gas"
  | "tech_tier_reached"
  | "tech_path_winrate"
  | "composition_matchup";

export type PhaseName = "early" | "mid" | "late";

export interface CohortTick {
  t: number;
  my: Partial<Record<MetricKey, BandRow>>;
  opp: Partial<Record<MetricKey, BandRow>>;
  composition?: {
    my: { winnerCentroid: Record<string, number>; loserCentroid: Record<string, number> } | null;
    opp: { winnerCentroid: Record<string, number>; loserCentroid: Record<string, number> } | null;
  };
}

export interface CohortResponse {
  cohortKey: string;
  cohortTier: 1 | 2 | 3 | 4;
  sampleSize: number;
  scope: SnapshotScope;
  ticks: CohortTick[];
  cached?: boolean;
}

export interface CohortTooSmall {
  tooSmall: true;
  sampleSize: number;
  requiredMin: number;
  cohortKey?: string;
}

export interface GameTick {
  t: number;
  phase?: PhaseName;
  my: {
    value: Partial<Record<MetricKey, number | null>>;
    scores: Partial<Record<MetricKey, number>>;
    aggregateScore: number;
  };
  opp: {
    value: Partial<Record<MetricKey, number | null>>;
    scores: Partial<Record<MetricKey, number>>;
    aggregateScore: number;
  };
  verdict: SnapshotVerdict;
  activeWeights?: Partial<Record<MetricKey, number>>;
  compositionDelta: {
    my: Array<DeltaRow>;
    opp: Array<DeltaRow>;
    mySimilarity: number;
    oppSimilarity: number;
  } | null;
  techPath?: TechPathBlock | null;
  compositionMatchup?: CompositionMatchupBlock | null;
}

export interface TechPathAlternative {
  pathId: string;
  signature?: string;
  label: string;
  winRate: number;
  winRateCI: [number, number];
  frequency: number;
  sampleSize?: number;
  total?: number;
}

export interface TechPathTransition {
  addedBuilding: string;
  afterSec: number;
  frequencyAmongWinners: number;
}

export interface TechPathBlock {
  pathId: string;
  pathLabel: string;
  buildingsInPath: string[];
  pathFrequency: number;
  pathWinRate: number;
  pathWinRateCI: [number, number];
  sampleSize: number;
  score: number;
  alternatives: TechPathAlternative[];
  transitions: TechPathTransition[];
}

export interface MatchupCluster {
  id: string;
  label: string;
  centroid: Record<string, number>;
  distanceFromCentroid?: number;
  secondClosest?: { id: string; distance: number } | null;
}

export interface MatchupCell {
  winRate: number;
  sampleSize: number;
  ci: [number, number];
}

export interface MatchupRowSummary {
  oppClusterId: string;
  oppLabel: string;
  winRate: number;
  sampleSize: number;
}

export interface CounterSuggestion {
  strategy: "switch_composition" | "switch_tech_path";
  targetClusterId?: string;
  targetClusterLabel?: string;
  currentPathId?: string;
  targetPathId?: string;
  targetPathLabel?: string;
  projectedWinRate: number;
  projectedWinRateCI: [number, number];
  sampleSize: number;
  unitsToAdd?: Record<string, number>;
  unitsToRemove?: Record<string, number>;
  buildingsToAdd?: string[];
  feasibility?: string;
  feasibilityNote?: string;
}

export interface CompositionMatchupBlock {
  myCluster: MatchupCluster;
  oppCluster: MatchupCluster;
  winRate: number;
  winRateCI: [number, number];
  neutralBand: [number, number];
  verdict: "favorable" | "neutral" | "unfavorable";
  sampleSize: number;
  fullRow: MatchupRowSummary[];
  fullMatrix: {
    myClusters: string[];
    oppClusters: string[];
    rows: MatchupCell[][];
  };
  counterSuggestions: CounterSuggestion[];
}

export interface MatrixResponse {
  matchup: string;
  scope: SnapshotScope;
  tick: number;
  cohortTier: number;
  sampleSize: number;
  matrix: {
    tick: number;
    myClusters: Array<{
      id: string;
      label: string;
      centroid: Record<string, number>;
      size: number;
    }>;
    oppClusters: Array<{
      id: string;
      label: string;
      centroid: Record<string, number>;
      size: number;
    }>;
    silhouettes: { my: number; opp: number };
    rows: MatchupCell[][];
  };
}

export interface DeltaRow {
  unit: string;
  mine: number;
  cohortWinnerMedian: number;
  delta: number;
  percentile: number;
}

export interface TimingMiss {
  type: "tech" | "unit";
  unit: string;
  cohortWinnerMedianAt: number | null;
  gameBuiltAt: number | null;
  severity: "low" | "medium" | "high";
  winnerShare: number;
}

export interface CoachingTagRow {
  t: number;
  tags: string[];
}

export interface GameSnapshotResponse {
  gameId: string;
  cohortKey: string;
  cohortTier: 1 | 2 | 3 | 4;
  sampleSize: number;
  ticks: GameTick[];
  insights: {
    inflectionTick: number | null;
    primaryMetric: string | null;
    secondaryMetric: string | null;
    timingMisses: TimingMiss[];
    coachingTags: CoachingTagRow[];
  };
  missingDetail?: boolean;
}

export interface TrendsRow {
  tickRange: [number, number];
  metric: MetricKey;
  lossesWhenBehind?: number;
  winsWhenAhead?: number;
  occurrences: number;
}

export interface TrendsResponse {
  userId: string;
  gameCount: number;
  recurringWeaknesses: TrendsRow[];
  strengths: TrendsRow[];
}

export interface NeighborRow {
  gameId: string;
  userId: string;
  similarityAtAnchor: number;
  result: "win" | "loss" | null;
  diffAtDivergence: Record<string, number>;
  summary: string;
}

export interface NeighborsResponse {
  anchor: { tick: number; vector: Record<string, number> };
  divergence?: { tick: number };
  neighbors: NeighborRow[];
  cohortKey: string;
  cohortTier: number | null;
  sampleSize: number;
}

export interface BuildsListResponse {
  builds: Array<{
    name: string;
    matchup: string;
    sampleSize: number;
    hasEnoughData: boolean;
  }>;
}

export const METRIC_LABELS: Record<MetricKey, string> = {
  army_value: "Army value",
  army_supply: "Supply",
  workers: "Workers",
  bases: "Bases",
  production_capacity: "Production capacity",
  income_min: "Mineral income",
  income_gas: "Gas income",
  tech_tier_reached: "Tech tier reached",
  tech_path_winrate: "Tech-path win rate",
  composition_matchup: "Composition matchup",
};

export const METRIC_SHORT_LABELS: Record<MetricKey, string> = {
  army_value: "Army",
  army_supply: "Supply",
  workers: "Workers",
  bases: "Bases",
  production_capacity: "Production",
  income_min: "Min/min",
  income_gas: "Gas/min",
  tech_tier_reached: "Tier",
  tech_path_winrate: "Path WR",
  composition_matchup: "Comp WR",
};

export function fmtTick(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function tierLabel(tier: number): string {
  if (tier === 1) return "Tier 1 · build + opening + MMR";
  if (tier === 2) return "Tier 2 · build + matchup";
  if (tier === 3) return "Tier 3 · build + matchup (broad)";
  if (tier === 4) return "Tier 4 · matchup only";
  return `Tier ${tier}`;
}
