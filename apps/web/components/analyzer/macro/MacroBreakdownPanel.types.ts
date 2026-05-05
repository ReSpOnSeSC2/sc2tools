/**
 * Shared types for the MacroBreakdown drilldown.
 *
 * The cloud API endpoint is GET /v1/games/:gameId/macro-breakdown
 * (see apps/api/src/services/perGameCompute.js#macroBreakdown). The
 * "slim" stored variant lacks `stats_events` / `opp_stats_events` /
 * `unit_timeline`; the chart treats those as optional and surfaces an
 * empty state when missing rather than mocking values.
 */

export type EffectiveRace = "Zerg" | "Protoss" | "Terran";

export interface LeakItem {
  /** Leak label, e.g. "Supply blocked at 3:42". */
  name?: string;
  /** Free-form supporting copy. */
  detail?: string;
  /** Score loss (positive points lost). */
  penalty?: number;
  /** Estimated minerals wasted, surfaced when known. */
  mineral_cost?: number;
  /** Game-time in seconds. The chart uses this to anchor the marker. */
  time?: number;
}

export interface LeakWindow {
  start: number;
  end: number;
  kind?: string;
}

export interface ChronoTarget {
  name: string;
  count: number;
}

export interface BreakdownRaw {
  sq?: number;
  base_score?: number;
  supply_block_penalty?: number;
  race_penalty?: number;
  float_penalty?: number;
  injects_actual?: number | null;
  injects_expected?: number | null;
  chronos_actual?: number | null;
  chronos_expected?: number | null;
  mules_actual?: number | null;
  mules_expected?: number | null;
  supply_blocked_seconds?: number | null;
  mineral_float_spikes?: number | null;
  leak_windows?: LeakWindow[];
  opp_leak_windows?: LeakWindow[];
  chrono_targets?: ChronoTarget[];
}

/**
 * One sample of a player's economic state. The agent's `PlayerStatsEvent`
 * stream samples at ~10s cadence — these arrive as plain objects on the
 * full (non-slim) breakdown.
 */
export interface StatsEvent {
  time: number;
  food_used?: number;
  food_made?: number;
  food_workers?: number;
  minerals_collection_rate?: number;
  vespene_collection_rate?: number;
}

export interface UnitTimelineEntry {
  time: number;
  my?: Record<string, number>;
  opp?: Record<string, number>;
}

export interface MacroBreakdownData {
  ok: boolean;
  macro_score?: number | null;
  race?: string | null;
  game_length_sec?: number;
  raw?: BreakdownRaw;
  all_leaks?: LeakItem[];
  top_3_leaks?: LeakItem[];
  /** Optional — only present on full (non-slim) breakdowns. */
  stats_events?: StatsEvent[];
  opp_stats_events?: StatsEvent[];
  unit_timeline?: UnitTimelineEntry[];
}

export interface RaceMeta {
  title: string;
  actualKey: keyof BreakdownRaw;
  expectedKey: keyof BreakdownRaw;
  unitPlural: string;
  winCopy: string;
  penaltyLabel: string;
}

export type PenaltyTone = "neutral" | "danger" | "success";

export interface PenaltyRow {
  label: string;
  /** Negative score impact in points (positive number means points lost). */
  value: number;
  tone: PenaltyTone;
}

/**
 * Caller-provided context surfaced in the panel header. The endpoint
 * itself doesn't return player metadata, so callers (game row, dashboard
 * stat) thread through whatever they already know.
 */
export interface PanelHeaderMeta {
  playerName?: string | null;
  myRace?: string | null;
  opponentName?: string | null;
  opponentRace?: string | null;
  map?: string | null;
  result?: string | null;
  dateIso?: string | null;
}

export interface MacroBreakdownPanelProps {
  open: boolean;
  onClose: () => void;
  gameId: string;
  /** Headline score from the calling row, used as a placeholder while loading. */
  initialScore?: number | null;
  headerMeta?: PanelHeaderMeta;
}
