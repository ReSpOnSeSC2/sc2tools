/**
 * Next-league targets — pure helpers behind the Macro tab's Targets card
 * and Today's strip.
 *
 * League tables are opponent-league bands (the API's league_percentiles and
 * league_timing_percentiles: SC2 matchmaking pairs near-equal ratings, so
 * the opponent's league stands in for the bracket a game was played in).
 * The player's own numbers are medians of their last 20 ranked 1v1 games in
 * the matchup. Everything here is plain arithmetic on those two inputs.
 */
import { BENCHMARK_MIN_SAMPLE, percentileOf, type LeagueBenchmark, type MetricBenchmark } from "@/lib/benchmarks";

export const LEAGUES = ["Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master", "Grandmaster"] as const;
/** League floors in MMR; mirrors apps/api/src/util/leagueBands.js. */
export const LEAGUE_MIN_MMR = [0, 900, 1800, 2700, 3600, 4600, 6500] as const;
const MAX_LEAGUE = LEAGUES.length - 1;

export type LeagueTargetsPrefs = { leagueOverride: number | null; targetLeague: number | null; targetMmr: number | null };
export const DEFAULT_LEAGUE_PREFS: LeagueTargetsPrefs = { leagueOverride: null, targetLeague: null, targetMmr: null };

export type TimingKey = "natural" | "third" | "firstUpgrade" | "keyTech";
export type TimingTable = {
  era: string; leagueId: number; league: string; matchup: string; n: number;
  timings: Record<TimingKey, MetricBenchmark>;
};
export type LadderRace = "P" | "T" | "Z" | "R";

export type TargetsResponse = {
  matchup: string | null;
  matchups: Array<{ matchup: string; games: number }>;
  sample: { n: number; limit: number };
  medians: Record<TargetMetric, { n: number; median: number | null }>;
  mmr: { current: number | null; at: string | null; region: string | null; ladderRace: LadderRace | null };
  netMmr: { pairs: number; games: number; perGame: number | null; window: number };
  timings: { era: string | null; n: number; limit: number; timings: Record<TimingKey, { n: number; median: number | null }> } | null;
};

/** A league id is an integer 0 (Bronze) … 6 (Grandmaster). */
export function isLeagueId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_LEAGUE;
}

/** Example: `leagueFromMmr(4120)` → 4 (Diamond); implausible ratings → null. */
export function leagueFromMmr(mmr: number | null | undefined): number | null {
  if (typeof mmr !== "number" || !Number.isFinite(mmr) || mmr < 1 || mmr > 8000) return null;
  let league = 0;
  LEAGUE_MIN_MMR.forEach((floor, id) => { if (mmr >= floor) league = id; });
  return league;
}

export type BandSource = "override" | "replays" | "pulse";
export type BandSelection = { current: number; next: number | null; source: BandSource; mmr: number | null };

/**
 * Which league to compare against and which one is next. A manual override
 * wins; otherwise the latest replay-recorded MMR, else SC2Pulse's current
 * rating. Grandmaster has no next league. Null: no league is known yet (the
 * card asks the player to set one).
 *
 * Example: `selectBands({ override: null, replayMmr: 4120, pulseMmr: null })`
 * → {current: 4, next: 5, source: "replays", mmr: 4120}.
 */
export function selectBands({ override, replayMmr, pulseMmr }: {
  override: number | null | undefined; replayMmr: number | null | undefined; pulseMmr: number | null | undefined;
}): BandSelection | null {
  const fromReplay = leagueFromMmr(replayMmr);
  const fromPulse = leagueFromMmr(pulseMmr);
  const mmr = fromReplay !== null ? replayMmr ?? null : fromPulse !== null ? pulseMmr ?? null : null;
  const pick = (current: number, source: BandSource): BandSelection =>
    ({ current, next: current < MAX_LEAGUE ? current + 1 : null, source, mmr });
  if (isLeagueId(override)) return pick(override, "override");
  if (fromReplay !== null) return pick(fromReplay, "replays");
  if (fromPulse !== null) return pick(fromPulse, "pulse");
  return null;
}

export type TargetMetric = "spq" | "macroScore" | "apm" | "durationSec";
export type MetricSpec = {
  key: TargetMetric; label: string; unit: string;
  /** Profile metrics have no better direction; they never say "needs". */
  direction: "higher" | "profile";
  /** /v1/games-list exclusive upper bound for "games below target". */
  drillParam: "sq_max" | "macro_max" | "apm_max" | null;
};
export const TARGET_METRICS: readonly MetricSpec[] = [
  { key: "spq", label: "Spending Quotient", unit: "SQ", direction: "higher", drillParam: "sq_max" },
  { key: "macroScore", label: "Macro score", unit: "macro", direction: "higher", drillParam: "macro_max" },
  { key: "apm", label: "APM", unit: "APM", direction: "higher", drillParam: "apm_max" },
  { key: "durationSec", label: "Game length", unit: "", direction: "profile", drillParam: null },
];

const p50 = (table: MetricBenchmark | null | undefined): number | null =>
  table && table.n >= BENCHMARK_MIN_SAMPLE && Array.isArray(table.deciles) && table.deciles.length === 9 ? table.deciles[4] : null;

export type TargetRow = {
  spec: MetricSpec;
  mine: number | null;
  mineN: number;
  percentile: { value: number; label: string } | null;
  deciles: number[] | null;
  currentP50: number | null;
  nextP50: number | null;
  /** Next league median minus yours (higher-is-better metrics only). */
  gap: number | null;
  /** below_floor: the current league's table is under the 50-game floor. */
  state: "ok" | "below_floor" | "no_sample";
};

/** One metric's row: your median against your league and the next. */
export function targetRow(spec: MetricSpec, mine: { n: number; median: number | null } | undefined,
  current: LeagueBenchmark | null | undefined, next: LeagueBenchmark | null | undefined): TargetRow {
  const value = typeof mine?.median === "number" && Number.isFinite(mine.median) ? mine.median : null;
  const table = current?.metrics[spec.key];
  const currentP50 = p50(table);
  const nextP50 = p50(next?.metrics[spec.key]);
  const gap = spec.direction === "higher" && value !== null && nextP50 !== null ? round1(nextP50 - value) : null;
  return {
    spec, mine: value, mineN: mine?.n ?? 0,
    percentile: value !== null ? percentileOf(table, value) : null,
    deciles: currentP50 !== null && table?.deciles ? table.deciles : null,
    currentP50, nextP50, gap,
    state: value === null ? "no_sample" : currentP50 === null ? "below_floor" : "ok",
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** "m:ss" for seconds. */
export function clock(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function formatMetric(spec: MetricSpec, value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return spec.key === "durationSec" ? clock(value) : spec.key === "apm" ? String(Math.round(value)) : value.toFixed(spec.key === "spq" ? 1 : 0);
}

/**
 * The row's sentence, e.g. "Diamond PvZ p38 → Master median needs +6 SQ".
 * Profile rows state the medians; at or above the next median it says so.
 */
export function gapText(row: TargetRow, league: string, nextLeague: string | null, matchup: string): string {
  const head = row.percentile ? `${league} ${matchup} ${percentileText(row.percentile)}` : `${league} ${matchup}`;
  if (!nextLeague || row.nextP50 === null) return row.currentP50 === null ? head : `${head} · median ${formatMetric(row.spec, row.currentP50)}`;
  if (row.spec.direction === "profile") return `${head} · ${nextLeague} median ${formatMetric(row.spec, row.nextP50)}`;
  if (row.gap === null) return head;
  if (row.gap <= 0) return `${head} → at or above the ${nextLeague} median`;
  const step = row.spec.key === "spq" ? row.gap.toFixed(1).replace(/\.0$/, "") : String(Math.ceil(row.gap));
  return `${head} → ${nextLeague} median needs +${step} ${row.spec.unit}`;
}

/** "p38", or "<p10" / ">p90" outside the measured deciles (lib/benchmarks labels). */
export function percentileText(percentile: { value: number; label: string }): string {
  if (percentile.label.startsWith("<")) return "<p10";
  if (percentile.label.startsWith(">")) return ">p90";
  return `p${Math.round(percentile.value)}`;
}

/**
 * The "pXX · League MU" tag that replaces the fixed SQ tier label when a
 * league table exists for the game; null means "fall back to the tier".
 *
 * Example: `percentileTag(diamondPvZ, "spq", 68)` → "p38 · Diamond PvZ".
 */
export function percentileTag(table: LeagueBenchmark | null | undefined, metric: TargetMetric, value: number | null | undefined): string | null {
  if (!table || typeof value !== "number" || !Number.isFinite(value)) return null;
  const pct = percentileOf(table.metrics[metric], value);
  return pct ? `${percentileText(pct)} · ${table.league} ${table.matchup}` : null;
}

export const TIMING_ROWS: ReadonlyArray<{ key: TimingKey; label: string; hint: string }> = [
  { key: "natural", label: "Natural", hint: "2nd town hall started" },
  { key: "third", label: "Third base", hint: "3rd town hall started" },
  { key: "firstUpgrade", label: "First upgrade", hint: "earliest tracked upgrade finished" },
  { key: "keyTech", label: "Key tech", hint: "first tech step" },
];

export type TimingRow = { key: TimingKey; label: string; hint: string; mine: number | null; mineN: number;
  currentP50: number | null; nextP50: number | null; gap: number | null };

/** One timing: your median vs the medians; ``gap`` > 0 means later than the next league. */
export function timingRow(row: (typeof TIMING_ROWS)[number], mine: { n: number; median: number | null } | undefined,
  current: TimingTable | null | undefined, next: TimingTable | null | undefined): TimingRow {
  const value = typeof mine?.median === "number" ? mine.median : null;
  const currentP50 = p50(current?.timings[row.key]);
  const nextP50 = p50(next?.timings[row.key]);
  return { ...row, mine: value, mineN: mine?.n ?? 0, currentP50, nextP50,
    gap: value !== null && nextP50 !== null ? Math.round(value - nextP50) : null };
}

/** "12 s later than the Master median", "8 s earlier…", "matches…". */
export function timingGapText(gap: number | null, league: string | null): string | null {
  if (gap === null || !league) return null;
  if (Math.abs(gap) < 1) return `matches the ${league} median`;
  return `${Math.abs(gap)} s ${gap > 0 ? "later" : "earlier"} than the ${league} median`;
}

export type SeasonEstimate =
  | { state: "no_mmr" }
  | { state: "no_target" }
  | { state: "reached"; target: number; mmrToGo: 0 }
  | { state: "no_trend"; target: number; mmrToGo: number }
  | { state: "estimate"; target: number; mmrToGo: number; games: number; weeksLeft: number | null; perWeek: number | null };

/**
 * The Season goal's plain arithmetic, labelled as an estimate by the UI:
 * MMR to go = target − current; games = MMR to go ÷ average net MMR per game
 * (rounded up); per week = games ÷ weeks left in the season (rounded up).
 * A flat or falling average has no finite estimate.
 *
 * Example: current 4400, target 4600, +5 per game, 4 weeks left →
 * {mmrToGo: 200, games: 40, perWeek: 10}.
 */
export function seasonEstimate({ currentMmr, prefs, perGame, seasonEnd, now }: {
  currentMmr: number | null | undefined; prefs: LeagueTargetsPrefs; perGame: number | null | undefined;
  seasonEnd: string | null | undefined; now: number;
}): SeasonEstimate {
  const target = prefs.targetMmr ?? (isLeagueId(prefs.targetLeague) ? LEAGUE_MIN_MMR[prefs.targetLeague] : null);
  if (target === null) return { state: "no_target" };
  if (typeof currentMmr !== "number" || !Number.isFinite(currentMmr)) return { state: "no_mmr" };
  const mmrToGo = Math.max(0, Math.round(target - currentMmr));
  if (mmrToGo === 0) return { state: "reached", target, mmrToGo: 0 };
  if (typeof perGame !== "number" || !Number.isFinite(perGame) || perGame <= 0) return { state: "no_trend", target, mmrToGo };
  const games = Math.ceil(mmrToGo / perGame);
  const end = seasonEnd ? Date.parse(seasonEnd) : NaN;
  const weeksLeft = Number.isFinite(end) && end > now ? Math.round(((end - now) / (7 * 86_400_000)) * 10) / 10 : null;
  const perWeek = weeksLeft !== null ? Math.ceil(games / Math.max(weeksLeft, 1 / 7)) : null;
  return { state: "estimate", target, mmrToGo, games, weeksLeft, perWeek };
}

/** The matchup a filter snapshot pins down ("PvZ"), or null. */
export function matchupFromFilters(filters: { race?: string; opp_race?: string }): string | null {
  const mine = filters.race, theirs = filters.opp_race;
  return mine && theirs && /^[PTZ]$/.test(mine) && /^[PTZ]$/.test(theirs) ? `${mine}v${theirs}` : null;
}
