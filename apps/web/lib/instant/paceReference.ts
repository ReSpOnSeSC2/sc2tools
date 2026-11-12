import { isPaceEra, isPaceMatchup, paceCurves, startingWorkers, PACE_CHECKPOINT_INDEX, PACE_POINTS, PACE_WINDOW,
  type PaceCurves, type PaceEra, type PaceMatchup, type PaceSample } from "./paceCurves";

export const PACE_REFERENCE_MMR = 5300;
const MIN_GAMES = 30;
const MIN_OPPONENTS = 5;
const MAX_BUCKETS = 10;
const REFERENCE_VERSION = 1;

export type PaceBucket = PaceCurves & {
  matchup: PaceMatchup;
  era: PaceEra;
  games: number;
  opponents: number;
};

type SourceGame = {
  gameKey: string;
  opponentKey: string;
  anchorMmr: number;
  durationSec: number;
  matchup: PaceMatchup;
  era: PaceEra;
  samples: PaceSample[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSourceKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && value === value.trim();
}

function isSample(value: unknown): value is PaceSample {
  if (!isObject(value) || !isNumber(value.time)) return false;
  const metrics = [value.food_workers, value.minerals_collection_rate, value.vespene_collection_rate];
  return metrics.every((metric) => metric === undefined || isNumber(metric));
}

function readSourceGame(value: unknown): SourceGame | null {
  if (!isObject(value)) return null;
  const { gameKey, opponentKey, anchorMmr, durationSec, matchup, era, samples } = value;
  const identities = isSourceKey(gameKey) && isSourceKey(opponentKey);
  const context = isNumber(anchorMmr) && isNumber(durationSec) && isPaceMatchup(matchup) && isPaceEra(era);
  const hasSamples = Array.isArray(samples) && samples.every(isSample);
  return identities && context && hasSamples ? { gameKey, opponentKey, anchorMmr, durationSec, matchup, era, samples } : null;
}

function hasReferenceFloor(games: number, opponents: number): boolean {
  return Number.isSafeInteger(games) && games >= MIN_GAMES
    && Number.isSafeInteger(opponents) && opponents >= MIN_OPPONENTS && opponents <= games;
}

function isCurve(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === PACE_POINTS && value.every((point: unknown) => isNumber(point) && point >= 0);
}

function validIncome(curve: number[]): boolean {
  return curve[0] === 0 && curve[PACE_CHECKPOINT_INDEX] > 0
    && curve.every((point, i) => i === 0 || point >= curve[i - 1]);
}

function validWorkers(curve: unknown, era: PaceEra): curve is number[] {
  return isCurve(curve) && curve[0] === startingWorkers(era) && curve[PACE_CHECKPOINT_INDEX] > 0;
}

function readBucket(value: unknown): PaceBucket | null {
  if (!isObject(value)) return null;
  const { matchup, era, games, opponents, workers, income } = value;
  if (!isPaceMatchup(matchup) || !isPaceEra(era) || !isNumber(games) || !isNumber(opponents)) return null;
  if (!hasReferenceFloor(games, opponents)) return null;
  return validWorkers(workers, era) && isCurve(income) && validIncome(income) ? { matchup, era, games, opponents, workers, income } : null;
}

export function readPaceReference(value: unknown): PaceBucket[] {
  if (!isObject(value) || value.version !== REFERENCE_VERSION || !Array.isArray(value.buckets) || value.buckets.length > MAX_BUCKETS) return [];
  const entries = value.buckets.map(readBucket);
  if (entries.some((entry) => entry === null)) return [];
  const buckets = entries.filter((entry) => entry !== null);
  const keys = new Set(buckets.map(({ matchup, era }) => matchup + era));
  return keys.size === buckets.length ? buckets : [];
}

type ReferenceGroup = Pick<PaceBucket, "matchup" | "era"> & {
  opponents: Set<string>;
  games: PaceCurves[];
};

function eligibleCurve(game: SourceGame): PaceCurves | null {
  // The anchor is the collection's Protoss player, including when the
  // sampled perspective is their Terran or Zerg opponent.
  if (Math.round(game.anchorMmr / 100) * 100 !== PACE_REFERENCE_MMR || game.durationSec < PACE_WINDOW) return null;
  const curve = paceCurves(game.samples, game.era, game.durationSec);
  return curve && validIncome(curve.income) ? curve : null;
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle] : values[middle - 1] / 2 + values[middle] / 2;
}

function medianCurve(games: PaceCurves[], key: keyof PaceCurves): number[] {
  return Array.from({ length: PACE_POINTS }, (_, i) => median(games.map((game) => game[key][i])));
}

function bucketFor(group: ReferenceGroup): PaceBucket[] {
  const games = group.games.length, opponents = group.opponents.size;
  if (!hasReferenceFloor(games, opponents)) return [];
  const workers = medianCurve(group.games, "workers"), income = medianCurve(group.games, "income");
  return validWorkers(workers, group.era) ? [{ matchup: group.matchup, era: group.era, games, opponents, workers, income }] : [];
}

/** Export only cohort sizes and medians, never a source identifier or replay. */
export function buildPaceReference(source: unknown): { version: number; buckets: PaceBucket[] } {
  if (!Array.isArray(source)) throw new Error("Expected an array of normalized reference games.");
  const groups = new Map<string, ReferenceGroup>();
  const seen = new Set<string>();
  for (const [index, entry] of source.entries()) {
    const game = readSourceGame(entry);
    if (!game) throw new Error(`Invalid reference game at row ${index + 1}.`);
    const key = game.matchup + game.era;
    const duplicate = JSON.stringify([game.gameKey, game.matchup]);
    if (seen.has(duplicate)) throw new Error(`Duplicate reference game at row ${index + 1}.`);
    seen.add(duplicate);
    const curve = eligibleCurve(game);
    if (!curve) continue;
    const group = groups.get(key) ?? { matchup: game.matchup, era: game.era, opponents: new Set<string>(), games: [] };
    group.opponents.add(game.opponentKey);
    group.games.push(curve);
    groups.set(key, group);
  }
  const buckets = [...groups.keys()].sort().flatMap((key) => {
    const group = groups.get(key);
    return group ? bucketFor(group) : [];
  });
  return { version: REFERENCE_VERSION, buckets };
}
