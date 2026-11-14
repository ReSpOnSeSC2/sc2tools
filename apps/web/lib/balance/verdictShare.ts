import { BALANCE_COHORT_OPTIONS, readBalancePin, type BalancePin, type BalanceRace } from "./evidence";

const VERDICT_LABELS = {
  imba: "Imba",
  split: "Split decision",
  contempt: "Contempt",
  replay: "Replay evidence",
  insufficient: "Inconclusive",
} as const;

export type Verdict = keyof typeof VERDICT_LABELS;

export function ladderShare(winRate: number): number {
  return winRate >= 0.5 ? 0 : (0.5 - winRate) / (1 - winRate);
}

export function replayVerdictLabel(verdict: Verdict) {
  return VERDICT_LABELS[verdict];
}

export type ReplayVerdict = BalancePin & {
  race: BalanceRace;
  opponent: BalanceRace;
  cohort: string;
  verdict: Verdict;
  mapId?: number;
};

/** Explicit allow-list. Replay identifiers, dates, MMR, autopsy notes and opponent data stay local. */
export function replayVerdictPath(value: ReplayVerdict): string {
  const { season, asOf, race, opponent, cohort, verdict, mapId } = value;
  const fragment = new URLSearchParams({ verdict, season: String(season), asOf, race, opponent, cohort });
  if (mapId !== undefined) fragment.set("map", String(mapId));
  return `/balance/verdict#${fragment}`;
}

export function readReplayVerdict(hash: string): ReplayVerdict | null {
  if (!hash.startsWith("#") || hash.length > 240) return null;
  const params = new URLSearchParams(hash.slice(1));
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => !["verdict", "season", "asOf", "race", "opponent", "cohort", "map"].includes(key))) return null;
  const pin = readBalancePin(params);
  const race = params.get("race");
  const opponent = params.get("opponent");
  const cohort = params.get("cohort");
  const verdict = params.get("verdict");
  const map = params.get("map");
  const mapId = map === null ? undefined : Number(map);
  if (!pin || (race !== "P" && race !== "T" && race !== "Z") || (opponent !== "P" && opponent !== "T" && opponent !== "Z")
    || race === opponent || !cohort || !BALANCE_COHORT_OPTIONS.some(option => option.value === cohort)
    || !verdict || !Object.hasOwn(VERDICT_LABELS, verdict)
    || (mapId !== undefined && (!/^[1-9]\d*$/.test(map ?? "") || !Number.isSafeInteger(mapId)))) return null;
  return { ...pin, race, opponent, cohort, verdict: verdict as Verdict, ...(mapId !== undefined ? { mapId } : {}) };
}
