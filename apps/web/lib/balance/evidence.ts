import { API_BASE } from "@/lib/apiBase";
import { wilsonInterval } from "@/lib/wilson";
import { BALANCE_LEAGUES, BALANCE_MATCHUPS, LEAGUE_NAMES, balanceTierKey, balanceTierLabel, type BalanceLeague, type BalanceMatchup } from "./bundle";

const REGION_IDS = ["US", "EU", "KR"] as const;
export const BALANCE_RACE_NAMES = { P: "Protoss", T: "Terran", Z: "Zerg" } as const;
export const SC2PULSE_URL = "https://sc2pulse.nephest.com/sc2/";
export type BalanceRace = keyof typeof BALANCE_RACE_NAMES;
export type BalancePin = { season: number; asOf: string };
export type EvidenceCounts = { matchup: BalanceMatchup; wins: number; games: number };
export type EvidenceTier = {
  league: BalanceLeague;
  division: 1 | 2 | 3 | null;
  bounds: { region: typeof REGION_IDS[number]; minRating: number; maxRating: number }[];
  matchups: EvidenceCounts[];
  mapMatchups: (EvidenceCounts & { mapId: number })[];
};
export type BalanceEvidence = BalancePin & { maps: { id: number; name: string }[]; tiers: EvidenceTier[] };

const TIERS = BALANCE_LEAGUES.flatMap(league =>
  (league === "grandmaster" ? [null] : [1, 2, 3] as const).map(division => ({ league, division })),
);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function whole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function readBalancePin(search: URLSearchParams): BalancePin | null {
  const season = search.get("season");
  const asOf = search.get("asOf");
  if (search.getAll("season").length !== 1 || search.getAll("asOf").length !== 1) return null;
  if (!season || !/^[1-9]\d{0,8}$/.test(season) || !isDay(asOf)) return null;
  return { season: Number(season), asOf };
}

function readMap(value: unknown) {
  if (!record(value) || !whole(value.id) || value.id === 0
    || typeof value.name !== "string" || !value.name.trim() || value.name.length > 120) return null;
  return { id: value.id, name: value.name };
}

function readCounts(value: unknown): EvidenceCounts | null {
  if (!record(value) || !whole(value.games) || !whole(value.wins) || value.wins > value.games) return null;
  const matchup = BALANCE_MATCHUPS.find(pair => pair === value.matchup);
  return matchup ? { matchup, wins: value.wins, games: value.games } : null;
}

function readBounds(value: unknown) {
  if (!record(value) || !whole(value.minRating) || !whole(value.maxRating) || value.minRating > value.maxRating) return null;
  const region = REGION_IDS.find(candidate => candidate === value.region);
  return region ? { region, minRating: value.minRating, maxRating: value.maxRating } : null;
}

function readMapCounts(value: unknown, maps: Set<number>) {
  if (!record(value) || !whole(value.mapId) || !maps.has(value.mapId)) return null;
  const counts = readCounts(value);
  return counts ? { ...counts, mapId: value.mapId } : null;
}

const distinct = <T,>(rows: T[], key: (row: T) => string | number) => new Set(rows.map(key)).size === rows.length;

function readTier(value: unknown, maps: Set<number>): EvidenceTier | null {
  if (!record(value) || !Array.isArray(value.bounds) || !Array.isArray(value.matchups) || !Array.isArray(value.mapMatchups)) return null;
  const tier = TIERS.find(row => row.league === value.league && row.division === value.division);
  if (!tier) return null;
  const bounds = value.bounds.map(readBounds);
  const matchups = value.matchups.map(readCounts);
  const mapMatchups = value.mapMatchups.map(row => readMapCounts(row, maps));
  if (!bounds.every(row => row !== null) || !distinct(bounds, row => row.region)) return null;
  if (!matchups.every(row => row !== null) || matchups.length !== 3 || !distinct(matchups, row => row.matchup)) return null;
  if (!mapMatchups.every(row => row !== null) || !distinct(mapMatchups, row => `${row.mapId}/${row.matchup}`)) return null;
  return { ...tier, bounds, matchups, mapMatchups };
}

export function readBalanceEvidence(value: unknown): BalanceEvidence | null {
  if (!record(value) || !whole(value.season) || value.season === 0 || !isDay(value.asOf)
    || !Array.isArray(value.maps) || !Array.isArray(value.tiers) || value.tiers.length !== TIERS.length) return null;
  const maps = value.maps.map(readMap);
  if (!maps.every(map => map !== null) || !distinct(maps, map => map.id)) return null;
  const ids = new Set(maps.map(map => map.id));
  const tiers = value.tiers.map(row => readTier(row, ids));
  if (!tiers.every(tier => tier !== null) || !distinct(tiers, balanceTierKey)) return null;
  return { season: value.season, asOf: value.asOf, maps, tiers };
}

export async function loadBalanceEvidence(pin?: BalancePin, signal?: AbortSignal): Promise<BalanceEvidence> {
  const timeout = AbortSignal.timeout(10_000);
  const query = pin ? `?${new URLSearchParams({ season: String(pin.season), asOf: pin.asOf })}` : "";
  const response = await fetch(`${API_BASE}/v1/ladder/balance/evidence${query}`, {
    credentials: "omit", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(response.status === 404 && pin ? "This snapshot is unavailable." : "Ladder evidence is temporarily unavailable.");
  const evidence = readBalanceEvidence(await response.json());
  if (!evidence || (pin && (evidence.season !== pin.season || evidence.asOf !== pin.asOf))) {
    throw new Error("The requested ladder snapshot could not be verified.");
  }
  return evidence;
}

export function matchupFor(race: BalanceRace, opponent: BalanceRace): BalanceMatchup | null {
  return BALANCE_MATCHUPS.find(pair => pair === `${race}v${opponent}` || pair === `${opponent}v${race}`) ?? null;
}

function matchesCohort(tier: Pick<EvidenceTier, "league" | "division">, key: string) {
  return tier.league === key || balanceTierKey(tier) === key;
}

export const BALANCE_COHORT_OPTIONS = BALANCE_LEAGUES.flatMap(league => [
  { value: league, label: LEAGUE_NAMES[league] },
  ...TIERS.filter(tier => tier.league === league && tier.division !== null).map(tier => ({ value: balanceTierKey(tier), label: balanceTierLabel(tier) })),
]);

export function cohortOptions(evidence: BalanceEvidence) {
  return BALANCE_COHORT_OPTIONS.filter(option => evidence.tiers.some(tier => matchesCohort(tier, option.value)));
}

/** Pool only disjoint same-tier games, then orient wins to the selected race. */
export function getBalanceCohort(evidence: BalanceEvidence, key: string, race: BalanceRace, opponent: BalanceRace, mapId?: number) {
  const matchup = matchupFor(race, opponent);
  if (!matchup) return null;
  let games = 0;
  let wins = 0;
  for (const tier of evidence.tiers) {
    if (!matchesCohort(tier, key)) continue;
    const counts = mapId === undefined ? tier.matchups.find(row => row.matchup === matchup)
      : tier.mapMatchups.find(row => row.mapId === mapId && row.matchup === matchup);
    if (!counts) continue;
    games += counts.games;
    wins += matchup[0] === race ? counts.wins : counts.games - counts.wins;
  }
  const confidence = mapId === undefined ? 95 : 99;
  const interval = wilsonInterval(wins, games, confidence === 95 ? 1.96 : 2.58);
  return interval ? { matchup, wins, games, winRate: wins / games, interval, confidence } : null;
}
