import { BALANCE_MATCHUPS, BALANCE_RACES, type BalanceMatchup } from "@/lib/balance/bundle";
import { BALANCE_COHORT_OPTIONS, readBalancePin, type BalancePin, type BalanceRace } from "@/lib/balance/evidence";

export type ClaimSelection = {
  matchup: BalanceMatchup;
  race: BalanceRace;
  cohort: string;
  mapId?: number;
};

export const DEFAULT_CLAIM: ClaimSelection = { matchup: "PvT", race: "P", cohort: "diamond-1" };
export const MATCHUP_SIDES: Record<BalanceMatchup, readonly [BalanceRace, BalanceRace]> = {
  PvT: ["P", "T"], PvZ: ["P", "Z"], TvZ: ["T", "Z"],
};

export function parseMatchup(slug: string): BalanceMatchup | undefined {
  return BALANCE_MATCHUPS.find(matchup => matchup.toLowerCase() === slug);
}

export function matchupTitle(matchup: BalanceMatchup): string {
  return BALANCE_RACES[matchup].join(" vs ");
}

export function opponentFor({ matchup, race }: ClaimSelection): BalanceRace {
  const [first, second] = MATCHUP_SIDES[matchup];
  return race === first ? second : first;
}

export function readClaimFragment(fragment: string): { pin: BalancePin; selection: ClaimSelection } | null {
  const fields = new URLSearchParams(fragment.replace(/^#/, ""));
  const pin = readBalancePin(fields);
  const matchup = parseMatchup(fields.get("matchup") ?? "");
  const race = fields.get("race");
  const cohort = fields.get("tier");
  const map = fields.get("map");
  if (!pin || !matchup || !cohort || !BALANCE_COHORT_OPTIONS.some(option => option.value === cohort)) return null;
  if (["matchup", "tier", "race"].some(key => fields.getAll(key).length !== 1) || fields.getAll("map").length > 1) return null;
  const side = MATCHUP_SIDES[matchup].find(candidate => candidate === race);
  if (!side || (map !== null && !/^[1-9][0-9]*$/.test(map))) return null;
  const mapId = map === null ? undefined : Number(map);
  if (mapId !== undefined && !Number.isSafeInteger(mapId)) return null;
  return { pin, selection: { matchup, race: side, cohort, mapId } };
}

export function claimPath(pin: BalancePin, { matchup, cohort, race, mapId }: ClaimSelection): string {
  const fields = new URLSearchParams({
    season: String(pin.season), asOf: pin.asOf, matchup: matchup.toLowerCase(), tier: cohort, race,
  });
  if (mapId !== undefined) fields.set("map", String(mapId));
  return `/balance/claim#${fields.toString()}`;
}
