import { patchEraForGame, pulseMatchup } from "@/lib/ladderPulse";
import { isPaceMatchup, paceCrossing, paceCurves, PACE_CHECKPOINT_INDEX, PACE_WINDOW, type PaceEra } from "./paceCurves";
import { readPaceReference, type PaceBucket } from "./paceReference";
import reference from "./pace-reference.json";
import type { InstantPayload } from "./reportPayload";

type PaceGame = Pick<InstantPayload, "gameId" | "date" | "durationSec" | "gameVersion" | "gameBuild" |
  "isLadderGame" | "myRace" | "myBuild" | "opponent" | "macroBreakdown">;
type MissingGap = { kind: "short" } | { kind: "missing-samples" } | { kind: "not-ladder" }
  | { kind: "no-reference"; matchup: string | null };
type MeasuredGap = {
  kind: "measured";
  matchup: string;
  era: PaceEra;
  games: number;
  opponents: number;
  workers: number | null;
  income: number | null;
};
export type PaceGap = { allIn: boolean } & (MissingGap | MeasuredGap);

const REFERENCES = readPaceReference(reference);
const ALL_IN = /\ball[- ]in\b/i;
// The replay detector documents these openings as all-ins without naming them that way.
const DETECTED_ALL_INS = new Set([
  "terran - 3-4 rax marine rush",
  "tvt - proxy 4 rax reaper", "tvt - 3 rax marine",
  "tvz - proxy 4 rax reaper", "tvz - 3 rax marine",
  "tvp - proxy 4 rax reaper", "tvp - 3 rax marine", "tvp - 1-1-1 one base",
  "zvt - 2 base nydus", "zvp - 2 base nydus", "zvz - 2 base nydus",
  "zvt - ling bane bust", "zvp - ling bane bust",
  "zvz - 12 pool into baneling",
]);

function comparedSeconds(curve: readonly number[], reference: readonly number[]): number | null {
  const target = reference[PACE_CHECKPOINT_INDEX];
  const crossing = paceCrossing(curve, target);
  const referenceCrossing = paceCrossing(reference, target);
  return crossing === null || referenceCrossing === null ? null : Math.round(crossing - referenceCrossing);
}

function hasAllInLabel(game: PaceGame): boolean {
  return [game.myBuild, game.opponent?.strategy].some((label) =>
    typeof label === "string" && (ALL_IN.test(label) || DETECTED_ALL_INS.has(label.trim().toLowerCase())));
}

export function gamePaceGap(game: PaceGame, references: readonly PaceBucket[] = REFERENCES): PaceGap {
  const allIn = hasAllInLabel(game);
  const matchup = pulseMatchup(game);
  if (game.isLadderGame !== true) return { kind: "not-ladder", allIn };
  if (!isPaceMatchup(matchup)) return { kind: "no-reference", matchup, allIn };
  if (game.durationSec === null) return { kind: "missing-samples", allIn };
  if (game.durationSec < PACE_WINDOW) return { kind: "short", allIn };
  const era = patchEraForGame(game);
  const baseline = references.find((bucket) => bucket.era === era && bucket.matchup === matchup);
  if (!baseline) return { kind: "no-reference", matchup, allIn };
  const curve = paceCurves(game.macroBreakdown?.stats_events ?? [], era, game.durationSec);
  if (!curve) return { kind: "missing-samples", allIn };
  return { kind: "measured", matchup, era, games: baseline.games, opponents: baseline.opponents,
    workers: comparedSeconds(curve.workers, baseline.workers), income: comparedSeconds(curve.income, baseline.income), allIn };
}
