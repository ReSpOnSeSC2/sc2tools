// Mode registry. Exported lazily via dynamic import so each mode
// stays out of the initial bundle. Each mode file calls
// `registerMode(id, depthTag)` at module-eval time; the depth-lint
// test imports this index to assert the registry is populated and
// every entry's depthTag is a known DepthTag.

import type { Mode, ScoreResult } from "../types";

export type AnyMode = Mode<unknown, unknown, ScoreResult>;

// Static imports keep the depth-lint working; lazy-loading is done at
// the rendering layer (next/dynamic in the runner). Modes themselves
// are tiny ~3kb each, so the static import is the right trade-off
// against the depth-lint complexity.
import { opponentBracketPick } from "./quizzes/opponentBracketPick";
import { rivalryRanker } from "./quizzes/rivalryRanker";
import { activeStreakHunter } from "./quizzes/activeStreakHunter";
import { streakVeto } from "./quizzes/streakVeto";
import { firstGameOfDay } from "./quizzes/firstGameOfDay";
import { streakAfterLoss } from "./quizzes/streakAfterLoss";
import { comebackCount } from "./quizzes/comebackCount";
import { lossPatternSleuth } from "./quizzes/lossPatternSleuth";
import { closersEye } from "./quizzes/closersEye";
import { macroMemory } from "./quizzes/macroMemory";

import { stockMarket } from "./games/stockMarket";
import { bingoLadder } from "./games/bingoLadder";
import { buildle } from "./games/buildle";
import { twoTruthsLie } from "./games/twoTruthsLie";
import { higherOrLower } from "./games/higherOrLower";
import { buildsAsCards } from "./games/buildsAsCards";

export const QUIZZES: AnyMode[] = [
  opponentBracketPick,
  rivalryRanker,
  activeStreakHunter,
  streakVeto,
  firstGameOfDay,
  streakAfterLoss,
  comebackCount,
  lossPatternSleuth,
  closersEye,
  macroMemory,
] as unknown as AnyMode[];

export const GAMES: AnyMode[] = [
  stockMarket,
  bingoLadder,
  buildle,
  twoTruthsLie,
  higherOrLower,
  buildsAsCards,
] as unknown as AnyMode[];

export const ALL_MODES: AnyMode[] = [...QUIZZES, ...GAMES];

export function modeById(id: string): AnyMode | undefined {
  return ALL_MODES.find((m) => m.id === id);
}
