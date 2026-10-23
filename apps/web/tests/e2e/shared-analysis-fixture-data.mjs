// Synthetic game analysis for real-component browser interactions only.
export const sharedAnalysisRoot = "/players/fixture-analysis-player/replays";
export function sharedAnalysisFixtureData(gameId = "current-game") {
  const samples = Array.from({ length: 61 }, (_, index) => ({ time: index * 15, army_value: index * 45, minerals_current: 250 + index * 5, food_used: 12 + index * 2, food_made: 23 + index * 2, food_workers: 12 + Math.min(index, 55) }));
  return {
    profile: { handle: "fixture-analysis-player", displayName: "Fixture Player" },
    game: { gameId, date: "2026-10-21T20:42:00Z", result: "Defeat", myRace: "Protoss", myBuild: "Blink pressure", myMmr: 4321, opponent: { displayName: "Fixture Rival", race: "Zerg", strategy: "Roach pressure", mmr: 4400 }, map: "Alcyone LE", durationSec: 900, macroScore: 79, replayAvailable: true, replaySizeBytes: 123456 },
    neighbors: { olderGameId: gameId === "older-game" ? null : "older-game", newerGameId: gameId === "newer-game" ? null : "newer-game" },
    macroBreakdown: { ok: true, race: "Protoss", macro_score: 79, game_length_sec: 900, raw: { sq: 80, chronos_actual: 8, chronos_expected: 10, supply_blocked_seconds: 25 }, stats_events: samples, opp_stats_events: samples.map((sample) => ({ ...sample, army_value: sample.army_value * 1.2 })), all_leaks: [
      { name: "Mineral float", detail: "Spend the bank before adding production.", penalty: 9, time: 402, mineral_cost: 600 },
      { name: "Supply block", detail: "Add the next pylon before the army cycle.", penalty: 7, time: 300, mineral_cost: 300 },
      { name: "Worker gap", penalty: 5, time: 180, mineral_cost: 200 }, { name: "Production delay", penalty: 3, time: 120, mineral_cost: 100 }, { name: "Late upgrade", penalty: 1, time: 600, mineral_cost: 40 },
    ] },
    buildOrder: { ok: true, events: [{ time: 14, name: "Pylon", category: "building" }, { time: 45, name: "Gateway", category: "building" }, { time: 105, name: "Stalker", category: "unit" }], opp_events: [{ time: 32, name: "Hatchery", category: "building" }, { time: 80, name: "SpawningPool", category: "building" }], my_status: "ok", opp_status: "ok" },
    streams: [{ platform: "twitch", perspective: "me", playerName: "Fixture Player", url: "https://www.twitch.tv/videos/123456", offsetSec: 60 }, { platform: "youtube", perspective: "opponent", playerName: "Fixture Rival", url: "https://www.youtube.com/watch?v=fixture", offsetSec: 80 }],
  };
}
