import type { ProfileGame } from "@/components/analyzer/Last5GamesTimeline";
import type { SessionHistoryGame } from "./sessionHistory";

const FORMATS = new Set(["1v1", "team", "ffa", "other"]);
export function sessionProfileGame(row: SessionHistoryGame): ProfileGame {
  const format = row.matchFormat && FORMATS.has(row.matchFormat) ? row.matchFormat as ProfileGame["matchFormat"] : null;
  return {
    id: row.id, date: row.date, gameVersion: row.gameVersion, gameBuild: row.gameBuild,
    matchFormat: format, playerCount: row.playerCount,
    result: row.outcome === "W" ? "Win" : row.outcome === "L" ? "Loss" : "Unknown",
    map: row.map, my_race: row.myRace, opp_race: row.opponent.race,
    opponent: row.opponent.displayName, opp_mmr: row.opponent.mmr,
    my_build: row.build.name, build_planned: row.buildPlanned, detected_build: row.detectedBuild,
    game_length: row.durationSec, macro_score: row.macroScore, my_mmr: row.myMmr,
    replayAvailable: row.replayAvailable, replaySizeBytes: row.replaySizeBytes,
  };
}
