export const BALANCE_LEAGUES = ["grandmaster", "master", "diamond", "platinum", "gold", "silver", "bronze"] as const;
export const BALANCE_MATCHUPS = ["PvT", "PvZ", "TvZ"] as const;

export type BalanceLeague = typeof BALANCE_LEAGUES[number];
export type BalanceMatchup = typeof BALANCE_MATCHUPS[number];
export type BalanceCohort = {
  wins: number;
  games: number;
  winRate: number | null;
  interval: { low: number; high: number } | null;
};
export type MatchupBalance = {
  matchup: BalanceMatchup;
  sameTier: BalanceCohort;
  crossTier: BalanceCohort;
};
export type BalanceTier = { league: BalanceLeague; division: 1 | 2 | 3 | null; matchups: MatchupBalance[] };
export type BalanceBundle = { season: number; asOf: string; tiers: BalanceTier[] };

const DEFAULT_TIER = "diamond-1";
const TIERS_TOTAL = (BALANCE_LEAGUES.length - 1) * 3 + 1;
export const LEAGUE_NAMES: Record<BalanceLeague, string> = {
  grandmaster: "Grandmaster", master: "Master", diamond: "Diamond", platinum: "Platinum",
  gold: "Gold", silver: "Silver", bronze: "Bronze",
};
export const BALANCE_RACES: Record<BalanceMatchup, readonly [string, string]> = {
  PvT: ["Protoss", "Terran"], PvZ: ["Protoss", "Zerg"], TvZ: ["Terran", "Zerg"],
};

export function balanceTierKey(tier: Pick<BalanceTier, "league" | "division">): string {
  return tier.division === null ? tier.league : `${tier.league}-${tier.division}`;
}

export function balanceTierLabel(tier: Pick<BalanceTier, "league" | "division">): string {
  const league = LEAGUE_NAMES[tier.league];
  return tier.division === null ? league : `${league} ${tier.division}`;
}

export function selectBalanceTier(bundle: BalanceBundle, key: string): BalanceTier | undefined {
  return bundle.tiers.find(tier => balanceTierKey(tier) === key)
    ?? bundle.tiers.find(tier => balanceTierKey(tier) === DEFAULT_TIER)
    ?? bundle.tiers[0];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function fraction(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function calendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString().startsWith(value);
}

function validInterval(interval: unknown, rate: number): interval is NonNullable<BalanceCohort["interval"]> {
  return record(interval) && fraction(interval.low) && fraction(interval.high)
    && interval.low <= rate && interval.high >= rate;
}

function readCohort(value: unknown): BalanceCohort | null {
  if (!record(value)) return null;
  const { wins, games, winRate, interval } = value;
  if (!count(wins) || !count(games) || wins > games) return null;
  if (games === 0) {
    return winRate === null && interval === null ? { wins, games, winRate, interval } : null;
  }
  if (!fraction(winRate) || Math.abs(winRate - wins / games) > 0.00005 + Number.EPSILON) return null;
  return validInterval(interval, winRate)
    ? { wins, games, winRate, interval: { low: interval.low, high: interval.high } }
    : null;
}

function readMatchup(value: unknown): MatchupBalance | null {
  if (!record(value)) return null;
  const matchup = BALANCE_MATCHUPS.find(key => key === value.matchup);
  const sameTier = readCohort(value.sameTier);
  const crossTier = readCohort(value.crossTier);
  return matchup && sameTier && crossTier ? { matchup, sameTier, crossTier } : null;
}

function readTier(value: unknown): BalanceTier | null {
  if (!record(value) || !Array.isArray(value.matchups) || value.matchups.length !== BALANCE_MATCHUPS.length) return null;
  const league = BALANCE_LEAGUES.find(key => key === value.league);
  const { division } = value;
  if (division !== null && division !== 1 && division !== 2 && division !== 3) return null;
  if (!league || (league === "grandmaster") !== (division === null)) return null;
  const matches = value.matchups.map(readMatchup);
  const matchups = BALANCE_MATCHUPS.map(key => matches.find(match => match?.matchup === key));
  return matchups.every(match => match != null) ? { league, division, matchups } : null;
}

/** Accept only a complete snapshot. Missing tiers must not silently become zero-game cohorts. */
export function readBalanceBundle(value: unknown): BalanceBundle | null {
  if (!record(value)) return null;
  const { season, asOf, tiers } = value;
  if (!count(season) || season === 0 || !calendarDay(asOf) || !Array.isArray(tiers) || tiers.length !== TIERS_TOTAL) {
    return null;
  }
  const parsed = tiers.map(readTier);
  if (!parsed.every(tier => tier !== null) || new Set(parsed.map(balanceTierKey)).size !== TIERS_TOTAL) return null;
  parsed.sort((a, b) => BALANCE_LEAGUES.indexOf(a.league) - BALANCE_LEAGUES.indexOf(b.league)
    || (a.division ?? 0) - (b.division ?? 0));
  return { season, asOf, tiers: parsed };
}
