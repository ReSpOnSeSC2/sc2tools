import { DAILY_ROUNDS } from "./rules";

export const SCOUT_ROOT = "/daily/scout/v1";
export const SCOUT_END = 360;
export const MAX_SCOUT_PACK_BYTES = 32_000;
export const MAX_SCOUT_BUILDINGS = 40;

// A deliberately small set whose strategies have distinct building clues.
// The owner tool verifies every label against the Python strategy detectors.
export const SCOUT_STRATEGIES = [
  ["Protoss - Cannon Rush", "Protoss - Stargate Opener", "Protoss - Robo Opener"],
  ["PvZ - Cannon Rush", "PvZ - Stargate Opener", "PvZ - Robo Opener"],
  ["Terran - Proxy Rax", "Terran - Fast 3 CC", "Terran - 1-1-1 One Base"],
  ["TvP - Proxy 4 Rax Reaper", "TvP - Fast 3 CC Bio", "TvP - Battlecruiser Rush"],
  ["Zerg - 12 Pool", "Zerg - 3 Hatch Before Pool", "Zerg - 2 Base Nydus"],
  ["ZvP - 12 Pool Rush", "ZvP - Hatch First Macro", "ZvP - 2 Base Nydus"],
] as const;
export type ScoutStrategy = (typeof SCOUT_STRATEGIES)[number][number];

export const SCOUT_BUILDINGS = {
  Barracks: "Barracks", Bunker: "Bunker", CommandCenter: "Command Center", Factory: "Factory", FusionCore: "Fusion Core",
  Refinery: "Refinery", Starport: "Starport", SupplyDepot: "Supply Depot",
  Assimilator: "Assimilator", CyberneticsCore: "Cybernetics Core", Forge: "Forge",
  Gateway: "Gateway", Nexus: "Nexus", PhotonCannon: "Photon Cannon", Pylon: "Pylon",
  RoboticsFacility: "Robotics Facility", Stargate: "Stargate",
  Extractor: "Extractor", Hatchery: "Hatchery", NydusNetwork: "Nydus Network",
  NydusCanal: "Nydus Worm", RoachWarren: "Roach Warren", SpawningPool: "Spawning Pool",
} as const;
export type ScoutBuildingName = keyof typeof SCOUT_BUILDINGS;
export type ScoutBuilding = [ScoutBuildingName, number, number, number];
export type ScoutPuzzle = {
  strategy: ScoutStrategy;
  width: number;
  height: number;
  buildings: ScoutBuilding[];
};
export type ScoutPack = { version: 1; puzzles: ScoutPuzzle[] };

export function scoutChoices(strategy: string): (typeof SCOUT_STRATEGIES)[number] | undefined {
  return SCOUT_STRATEGIES.find(group => group.some(choice => choice === strategy));
}

export function isScoutBuildingName(name: unknown): name is ScoutBuildingName {
  return typeof name === "string" && Object.hasOwn(SCOUT_BUILDINGS, name);
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function puzzleRow(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const puzzle = value as Record<string, unknown>;
  const keys = ["strategy", "width", "height", "buildings"];
  return Object.keys(puzzle).length === keys.length && keys.every(key => Object.hasOwn(puzzle, key)) ? puzzle : null;
}

function validBuilding(value: unknown, width: number, height: number, previousTime: number): value is ScoutBuilding {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const [name, time, x, y] = value;
  return isScoutBuildingName(name) && inRange(time, previousTime, SCOUT_END)
    && inRange(x, 0, width) && inRange(y, 0, height);
}

function validPuzzle(value: unknown): value is ScoutPuzzle {
  const puzzle = puzzleRow(value);
  if (!puzzle) return false;
  const { strategy, width, height, buildings } = puzzle;
  if (typeof strategy !== "string" || !scoutChoices(strategy)) return false;
  if (!inRange(width, 16, 256) || !inRange(height, 16, 256) || !Array.isArray(buildings)) return false;
  return validTimeline(buildings, width, height);
}

function validTimeline(buildings: unknown[], width: number, height: number): boolean {
  if (buildings.length < 3 || buildings.length > MAX_SCOUT_BUILDINGS) return false;
  let time = 0;
  for (const building of buildings) {
    if (!validBuilding(building, width, height, time)) return false;
    time = building[1];
  }
  return true;
}

export function readScoutPack(value: unknown): ScoutPack | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pack = value as Record<string, unknown>;
  if (Object.keys(pack).length !== 2 || pack.version !== 1 || !Array.isArray(pack.puzzles)) return null;
  if (pack.puzzles.length !== DAILY_ROUNDS || !pack.puzzles.every(validPuzzle)) return null;
  return { version: 1, puzzles: pack.puzzles };
}
