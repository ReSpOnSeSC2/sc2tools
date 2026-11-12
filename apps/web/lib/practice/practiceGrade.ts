import { readReferenceBuildOrder } from "@/lib/buildOrderReference";
import { BUILD_TOKENS } from "@/lib/buildTokens";
import type { GhostTarget } from "@/lib/ghostBuild";
import { gradeExecution } from "@/lib/ghostGrade";
import type { InstantPayload } from "@/lib/instant/reportPayload";
import { patchEraForGame } from "@/lib/ladderPulse";
import type { PatchEra } from "@/lib/meta";
import { referenceOrderPracticeTarget } from "@/lib/practiceTarget";
import { coerceRace, type Race } from "@/lib/race";

const GRADEABLE_TOKENS = new Set(BUILD_TOKENS.filter(token => token.kind !== "unit").map(token => token.token));
const MIN_TIMED_STEPS = 6;

export function practiceGradeTarget(name: string, reference: unknown, race: Race, endSec: number): GhostTarget | null {
  const order = readReferenceBuildOrder(reference);
  if (order?.source !== "game" || race === "Random") return null;
  const steps = order.steps.filter(step => step.t !== null && step.t <= endSec && GRADEABLE_TOKENS.has(step.action));
  const target = referenceOrderPracticeTarget(name, { ...order, steps }, race);
  return target && target.steps.length >= MIN_TIMED_STEPS ? target : null;
}

type GradeReplay = Pick<InstantPayload, "myRace" | "buildLog" | "gameVersion" | "gameBuild" | "date">;

export function gradePracticeReplay(target: GhostTarget, race: Race, era: PatchEra, replay: GradeReplay) {
  if (coerceRace(replay.myRace) !== race) return { kind: "wrong_race" } as const;
  const result = gradeExecution(target, replay.buildLog);
  const patchMismatch = patchEraForGame(replay) !== era;
  if (result.matchedSteps * 2 < result.targetSteps) return { kind: "wrong_build", patchMismatch } as const;
  return { kind: "grade", result, patchMismatch } as const;
}

export const practiceEraLabel = (era: PatchEra) => era === "before" ? "5.0.16 · 8 workers" : "12-worker patch era";
