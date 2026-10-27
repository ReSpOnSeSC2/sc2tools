import { expect, it } from "vitest";
import { sessionProfileGame } from "../sessionHistoryTable";
import type { SessionHistoryGame } from "../sessionHistory";

const row: SessionHistoryGame = {
  position: 1, gameId: null, id: null, date: "2026-10-27T03:40:00.000Z", outcome: "U",
  myToonHandle: null, ladderRace: null, matchup: "?v?", ratingScope: "unknown-unknown", comparable: false,
  recordedEndGapSec: null, durationSec: null, macroScore: 0, myMmr: 0, myMmrSource: "legacy",
  build: { name: "Planned label", provenance: "planned", detectedName: "Detected label" },
  map: "Map", myRace: "P", opponent: { displayName: "Opponent", race: "T", toonHandle: "1-S2-1-999", mmr: null },
  gameVersion: "5.0.16", gameBuild: 100000, matchFormat: "team", playerCount: 4, isLadderGame: true,
  buildPlanned: true, detectedBuild: "Detected label", replayAvailable: true, replaySizeBytes: 12345,
};

it("retains nullable identity, actual review format, zero samples and planned/detected/archive metadata", () => {
  expect(sessionProfileGame(row)).toMatchObject({ id: null, result: "Unknown", game_length: null, macro_score: 0, my_mmr: 0,
    matchFormat: "team", playerCount: 4, gameVersion: "5.0.16", gameBuild: 100000,
    my_build: "Planned label", build_planned: true, detected_build: "Detected label", replayAvailable: true, replaySizeBytes: 12345 });
  expect(sessionProfileGame(row)).not.toHaveProperty("opponentContext");
  expect(sessionProfileGame(row)).not.toHaveProperty("opponent_pulse_id");
});

it("keeps W/L canonical for the existing table, seconds unchanged and unsupported format unavailable", () => {
  expect(sessionProfileGame({ ...row, id: "g1", outcome: "W", durationSec: 600 }).result).toBe("Win");
  expect(sessionProfileGame({ ...row, outcome: "L", durationSec: 600 }).game_length).toBe(600);
  expect(sessionProfileGame({ ...row, matchFormat: "invented" }).matchFormat).toBeNull();
});
