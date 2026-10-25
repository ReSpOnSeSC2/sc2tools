import type { BattleReportInput } from "../facts";
import type { CasualtyEvent, StatsEvent } from "@/components/analyzer/macro/MacroBreakdownPanel.types";

// Synthetic fixtures cover twelve recognizable game shapes. They contain no
// owner replay, account, integration or provider data.
const shapes = [
  ["all-in", "Zerg", "Terran", 240, "Victory"],
  ["cheese-loss", "Protoss", "Zerg", 270, "Defeat"],
  ["macro-win", "Terran", "Protoss", 1200, "Victory"],
  ["comeback", "Zerg", "Protoss", 960, "Victory"],
  ["base-trade", "Protoss", "Terran", 1100, "Defeat"],
  ["short-gg", "Terran", "Zerg", 90, "Defeat"],
  ["zerg-mirror", "Zerg", "Zerg", 780, "Tie"],
  ["protoss-mirror", "Protoss", "Protoss", 900, "Victory"],
  ["terran-mirror", "Terran", "Terran", 1500, "Defeat"],
  ["worker-harass", "Protoss", "Zerg", 600, "Victory"],
  ["missing-detail", "Terran", "Zerg", 420, "Draw"],
  ["sparse-legacy", "Zerg", "Terran", 700, "Victory"],
] as const;
const hall = { Zerg: "Hatchery", Protoss: "Nexus", Terran: "CommandCenter" };
const tech = { Zerg: "RoachWarren", Protoss: "CyberneticsCore", Terran: "Factory" };
const worker = { Zerg: "Drone", Protoss: "Probe", Terran: "SCV" };
const fighter = { Zerg: "Roach", Protoss: "Stalker", Terran: "Marauder" };

export const reportFixtures: BattleReportInput[] = shapes.map(([shape, myRace, oppRace, durationSec, result]) => {
  const sample = (time: number, index: number, opponent = false): StatsEvent => ({
    time, army_value: shape === "comeback" ? opponent ? index < 8 ? 1800 : 500 : index < 8 ? 400 : 2400 : Math.max(100, index * 220 + (index % 4 === 0 ? -300 : 400)),
    food_workers: 12 + index * (opponent ? 2 : 3), minerals_collection_rate: 450 + index * 50, vespene_collection_rate: index * 20,
  });
  const times = Array.from({ length: Math.floor(durationSec / 30) + 1 }, (_, index) => index * 30);
  const casualty_events: CasualtyEvent[] = shape === "missing-detail" ? [] : [
    { time: Math.min(durationSec - 5, 120), owner: "opp", killer: "me", category: shape === "worker-harass" ? "workers" : "units", name: shape === "worker-harass" ? worker[oppRace] : fighter[oppRace] },
    { time: Math.min(durationSec - 2, 125), owner: "me", killer: "opp", category: "units", name: fighter[myRace] },
    ...(shape === "base-trade" ? [{ time: 1000, owner: "me" as const, killer: "opp" as const, category: "buildings" as const, name: hall[myRace] }, { time: 1020, owner: "opp" as const, killer: "me" as const, category: "buildings" as const, name: hall[oppRace] }] : []),
  ];
  return {
    game: { gameId: shape, map: `Fixture ${shape}`, date: "2026-10-20T12:00:00.000Z", myRace, durationSec, result, myBuild: `${myRace} classified opening`, detectedBuild: `${myRace} replay opening`, myMmr: 4200, opponent: { displayName: "Replay rival", race: oppRace, mmr: 4250, strategy: `${oppRace} opener` } },
    myName: "Replay player", plannedBuild: `${myRace} plan`,
    buildEvents: [{ time: 110, name: hall[myRace], category: "building" }, { time: 130, name: tech[myRace], category: "building" }, { time: 160, complete_time: 220, name: "RecordedUpgrade", category: "upgrade" }].filter(row => row.time < durationSec),
    breakdown: shape === "missing-detail" ? undefined : { ok: true, game_length_sec: durationSec, stats_events: times.map((time, index) => sample(time, index)), opp_stats_events: times.map((time, index) => sample(time, index, true)), ...(shape === "sparse-legacy" ? {} : { casualty_events }), raw: { supply_blocked_seconds: 20, supply_block_windows: [{ start: 35, end: 55, blocked_sec: 20 }] }, all_leaks: [{ name: "Supply Blocked", detail: "The replay's macro rules counted 20 blocked seconds.", mineral_cost: 200, time: 35 }] },
  };
});
