import { DAILY_ROUNDS, PRACTICE_DAYS } from "./rules";
import type { ScoutBuilding, ScoutPack, ScoutStrategy } from "./scout";

const OPENINGS: ReadonlyArray<[ScoutStrategy, ScoutBuilding[]]> = [
  ["Protoss - Cannon Rush", [
    ["Nexus", 0, 16, 19], ["Pylon", 18, 22, 23], ["Forge", 38, 25, 18],
    ["Pylon", 50, 66, 56], ["PhotonCannon", 75, 70, 57], ["PhotonCannon", 90, 74, 62],
  ]],
  ["Terran - Fast 3 CC", [
    ["CommandCenter", 0, 18, 16], ["SupplyDepot", 19, 29, 21], ["Barracks", 39, 25, 23],
    ["Refinery", 47, 12, 24], ["CommandCenter", 109, 34, 32], ["CommandCenter", 146, 47, 24],
    ["Factory", 167, 23, 12], ["Starport", 201, 19, 27],
  ]],
  ["Zerg - 12 Pool", [
    ["Hatchery", 0, 20, 20], ["SpawningPool", 17, 26, 14], ["Extractor", 45, 13, 25],
    ["Hatchery", 104, 37, 32], ["RoachWarren", 146, 15, 15],
  ]],
  ["Protoss - Stargate Opener", [
    ["Nexus", 0, 16, 19], ["Pylon", 18, 28, 21], ["Gateway", 38, 29, 16],
    ["Assimilator", 47, 12, 25], ["CyberneticsCore", 81, 24, 26], ["Nexus", 91, 39, 35],
    ["Stargate", 132, 22, 12],
  ]],
  ["Terran - Proxy Rax", [
    ["CommandCenter", 0, 15, 15], ["SupplyDepot", 18, 24, 19], ["Barracks", 38, 61, 51],
    ["Barracks", 54, 67, 48], ["Bunker", 93, 73, 60], ["SupplyDepot", 118, 24, 23],
  ]],
  ["Zerg - 3 Hatch Before Pool", [
    ["Hatchery", 0, 17, 19], ["Hatchery", 48, 35, 33], ["Hatchery", 79, 49, 20],
    ["SpawningPool", 99, 24, 15], ["Extractor", 112, 11, 25],
  ]],
  ["Protoss - Robo Opener", [
    ["Nexus", 0, 16, 19], ["Pylon", 18, 22, 26], ["Gateway", 38, 26, 18],
    ["Assimilator", 46, 10, 24], ["CyberneticsCore", 81, 27, 23], ["Nexus", 94, 35, 35],
    ["RoboticsFacility", 138, 16, 12],
  ]],
  ["Terran - 1-1-1 One Base", [
    ["CommandCenter", 0, 17, 16], ["SupplyDepot", 19, 27, 19], ["Barracks", 40, 23, 24],
    ["Refinery", 46, 11, 25], ["Refinery", 80, 10, 14], ["Factory", 118, 24, 13], ["Starport", 162, 27, 28],
  ]],
  ["Zerg - 2 Base Nydus", [
    ["Hatchery", 0, 17, 17], ["Hatchery", 48, 33, 31], ["SpawningPool", 70, 23, 13],
    ["Extractor", 72, 10, 22], ["RoachWarren", 148, 16, 11],
    ["NydusNetwork", 226, 20, 25], ["NydusCanal", 263, 67, 54],
  ]],
];

export function scoutPracticeWeek(): ScoutPack[] {
  return Array.from({ length: PRACTICE_DAYS }, (_, day) => ({
    version: 1,
    puzzles: Array.from({ length: DAILY_ROUNDS }, (_, slot) => {
      const [strategy, clues] = OPENINGS[(day * 2 + slot * 2) % OPENINGS.length];
      const buildings = clues.map(([name, time, x, y]): ScoutBuilding => [
        name, time ? time + (day % 3) * 2 : 0, day % 2 ? 80 - x : x, day % 3 ? y : 72 - y,
      ]);
      return { strategy, width: 80, height: 72, buildings };
    }),
  }));
}
