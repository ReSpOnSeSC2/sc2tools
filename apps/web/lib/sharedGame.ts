import type { GameBuildOrderResponse, GameSummary } from "@/components/analyzer/game/types";
import type { MacroBreakdownData } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import type { BenchmarkMetric, MetricBenchmark } from "./benchmarks";
import type { BattleReportInput } from "./battleReport/facts";
import type { MapPlayback } from "./mapReplay";
import { anonymousOpponent } from "./sharePrivacy";

/**
 * The public, redacted payload of a shared game (GET /v1/shares/:token,
 * apps/api/src/services/gameShares.js). The opponent is a race and a
 * rounded rating; the owner is a race; the game is dated to the day; the
 * labels are the replay classifier's. No ids or names.
 */
export interface SharedGame {
  matchup: string | null;
  myRace: string | null;
  oppRace: string | null;
  map: string | null;
  result: "Win" | "Loss" | "Draw" | null;
  durationSec: number | null;
  /** "YYYY-MM-DD" (UTC); never a time of day. */
  playedOn: string | null;
  myBuild: string | null;
  oppStrategy: string | null;
  macroScore: number | null;
  apm: number | null;
  spq: number | null;
  /** "Protoss player". */
  playerLabel: string;
  /** Rounded to 100. */
  playerMmr: number | null;
  playerBand: { id: string; label: string } | null;
  /** "Opponent (Zerg, ~4,100 MMR)". */
  opponentLabel: string;
  opponentMmr: number | null;
  opponentBand: { id: string; label: string } | null;
  matchFormat: "1v1" | "team" | "ffa" | "other" | null;
  playerCount: number | null;
}

export interface SharedBenchmark {
  league: string | null;
  matchup: string | null;
  n: number | null;
  updatedAt: string | null;
  metrics: Partial<Record<BenchmarkMetric, MetricBenchmark>>;
}

export interface SharedGameAnalysis {
  game: SharedGame;
  macroBreakdown: MacroBreakdownData | null;
  buildOrder: GameBuildOrderResponse | null;
  playback: { mode: "segmented" | "inline" | "none" };
  benchmark: SharedBenchmark | null;
}

/** The result as the analyzer's components spell it. */
export function sharedResultWord(result: SharedGame["result"]): string | null {
  return result === "Win" ? "Victory" : result === "Loss" ? "Defeat" : result === "Draw" ? "Tie" : null;
}

/**
 * The shared game as the analyzer components' ``GameSummary``. ``gameId``
 * is a page-local key (never the owner's game id); the opponent is a
 * label and race only; ratings are the rounded public ones.
 */
export function sharedGameSummary(game: SharedGame, key: string): GameSummary {
  return {
    gameId: key,
    date: game.playedOn ? `${game.playedOn}T12:00:00.000Z` : null,
    result: sharedResultWord(game.result),
    map: game.map,
    myRace: game.myRace,
    myBuild: game.myBuild,
    myMmr: game.playerMmr,
    durationSec: game.durationSec,
    playerCount: game.playerCount,
    matchFormat: game.matchFormat,
    macroScore: game.macroScore,
    apm: game.apm,
    spq: game.spq,
    opponent: { displayName: game.opponentLabel, race: game.oppRace, mmr: game.opponentMmr, strategy: game.oppStrategy },
  };
}

/** "PvZ on Alcyone LE" / "Alcyone LE" / "Shared game". */
export function sharedGameTitle(game: SharedGame | null | undefined): string {
  if (!game) return "Shared game";
  if (game.matchup && game.map) return `${game.matchup} on ${game.map}`;
  return game.matchup || game.map || "Shared game";
}

/**
 * A battle report input that is safe to show people other than the player
 * (share pages, report images): the shared voice ("the player"), the
 * opponent by race only (lib/sharePrivacy.ts), no ratings, no build
 * check-in or correction (the classifier's labels instead) and no replay
 * player names. Idempotent.
 */
export function shareSafeReportInput(input: BattleReportInput): BattleReportInput {
  const { game } = input;
  const oppRace = game.opponent?.race ?? null;
  return {
    ...input,
    voice: "shared",
    myName: "The player",
    plannedBuild: null,
    breakdown: input.breakdown ? { ...input.breakdown, player_stats: undefined } : input.breakdown,
    game: {
      gameId: game.gameId,
      date: game.date,
      result: game.result,
      map: game.map,
      myRace: game.myRace,
      durationSec: game.durationSec,
      gameVersion: game.gameVersion,
      gameBuild: game.gameBuild,
      macroScore: game.macroScore,
      myBuild: game.buildPlanned ? game.detectedBuild ?? null : game.myBuild ?? null,
      opponent: {
        displayName: anonymousOpponent(oppRace),
        race: oppRace,
        strategy: game.oppStrategyPlanned ? game.detectedOppStrategy ?? null : game.opponent?.strategy ?? null,
      },
    },
  };
}

/**
 * The share page's battle report input, from the redacted payload only.
 * ``key`` seeds the wording (a page-local id, never the owner's game id);
 * only complete inline ``playback`` may supply map stills.
 */
export function sharedReportInput(data: SharedGameAnalysis, key: string, playback: MapPlayback | null = null): BattleReportInput {
  return shareSafeReportInput({
    game: sharedGameSummary(data.game, key),
    breakdown: data.macroBreakdown,
    buildEvents: data.buildOrder?.events,
    oppBuildEvents: data.buildOrder?.opp_events,
    playback,
  });
}
