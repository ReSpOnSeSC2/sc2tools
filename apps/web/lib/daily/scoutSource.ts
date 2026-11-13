import { isScoutBuildingName, MAX_SCOUT_BUILDINGS, SCOUT_END, SCOUT_STRATEGIES, scoutChoices, type ScoutBuilding, type ScoutBuildingName, type ScoutPuzzle, type ScoutStrategy } from "./scout";

export const SCOUT_DETECTOR_FILES = [
  "strategy_detector_race.py", "strategy_detector_pvz.py", "strategy_detector_matchups.py",
] as const;

type Crop = { left: number; bottom: number; width: number; height: number };

function row(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function cropFrom(value: unknown): Crop | null {
  const crop = row(value);
  if (!crop) return null;
  const { left, bottom, width, height } = crop;
  if (!finite(left) || !finite(bottom) || !finite(width) || !finite(height)) return null;
  if (![left, bottom, width, height].every(Number.isSafeInteger)) return null;
  if (Math.min(width, height) < 16 || Math.max(width, height) > 256) return null;
  return { left, bottom, width, height };
}

function trackerBuilding(value: unknown, side: string): ScoutBuilding | null {
  const building = row(value);
  if (!building || building.owner !== side || !isScoutBuildingName(building.name)) return null;
  const { name, x, y, t } = building;
  if (!finite(x) || !finite(y) || !finite(t) || t < 0) return null;
  return [name, t, x, y];
}

function cropBuilding([name, t, x, y]: ScoutBuilding, crop: Crop): ScoutBuilding | null {
  if (t > SCOUT_END) return null;
  const localX = x - crop.left, localY = y - crop.bottom;
  if (Math.min(localX, localY) < 0 || localX > crop.width || localY > crop.height) return null;
  // Tracker payloads have at most three decimal places. Remove subtraction artifacts.
  return [name, t, Number(localX.toFixed(3)), Number(localY.toFixed(3))];
}

type Clue = readonly [ScoutBuildingName, number, count?: number];

const CLUES: Record<ScoutStrategy, readonly Clue[]> = {
  "Protoss - Cannon Rush": [["Nexus", 0]],
  "Protoss - Stargate Opener": [["Stargate", 390]],
  "Protoss - Robo Opener": [["RoboticsFacility", 390]],
  "PvZ - Cannon Rush": [["Nexus", 0]],
  "PvZ - Stargate Opener": [["Stargate", SCOUT_END]],
  "PvZ - Robo Opener": [["RoboticsFacility", SCOUT_END]],
  "Terran - Proxy Rax": [["CommandCenter", 0]],
  "Terran - Fast 3 CC": [["CommandCenter", 420, 3]],
  "Terran - 1-1-1 One Base": [["CommandCenter", 0], ["Barracks", SCOUT_END], ["Factory", SCOUT_END], ["Starport", SCOUT_END]],
  "TvP - Proxy 4 Rax Reaper": [["CommandCenter", 0], ["Barracks", 330, 4]],
  "TvP - Fast 3 CC Bio": [["CommandCenter", 360, 3], ["Barracks", 450, 3]],
  "TvP - Battlecruiser Rush": [["FusionCore", 420]],
  "Zerg - 12 Pool": [["Hatchery", 0], ["SpawningPool", 49.999]],
  "Zerg - 3 Hatch Before Pool": [["Hatchery", SCOUT_END, 3], ["SpawningPool", SCOUT_END]],
  "Zerg - 2 Base Nydus": [["Hatchery", SCOUT_END, 2], ["NydusNetwork", 420]],
  "ZvP - 12 Pool Rush": [["Hatchery", 0], ["SpawningPool", 54.999]],
  "ZvP - Hatch First Macro": [["Hatchery", 420, 3], ["SpawningPool", SCOUT_END]],
  "ZvP - 2 Base Nydus": [["Hatchery", SCOUT_END, 2], ["NydusNetwork", 450]],
};

function clueBuildings(clue: Clue, buildings: ScoutBuilding[]): ScoutBuilding[] {
  const [name, deadline, count = 1] = clue;
  const matches = buildings.filter(([kind, t]) => kind === name && t <= deadline).slice(0, count);
  if (matches.length !== count) throw new Error("The replay side is missing a required opening clue.");
  return matches;
}

const PROXY: Partial<Record<ScoutStrategy, readonly [ScoutBuildingName, number]>> = {
  "Protoss - Cannon Rush": ["PhotonCannon", 270],
  "PvZ - Cannon Rush": ["PhotonCannon", 270],
  "Terran - Proxy Rax": ["Barracks", 270],
  "TvP - Proxy 4 Rax Reaper": ["Barracks", 300],
};

function proxyClue(strategy: ScoutStrategy, required: ScoutBuilding[], buildings: ScoutBuilding[]): ScoutBuilding[] {
  const proxy = PROXY[strategy];
  if (!proxy) return [];
  const [, , mainX, mainY] = required[0];
  const [name, deadline] = proxy;
  const distant = buildings.find(([kind, t, x, y]) => kind === name && t <= deadline
    && Math.hypot(x - mainX, y - mainY) > 50);
  if (!distant) throw new Error("The replay side is missing a required proxy clue.");
  return [distant];
}

function verifyClueOrder(strategy: ScoutStrategy, required: ScoutBuilding[], buildings: ScoutBuilding[]) {
  if (strategy === "Terran - 1-1-1 One Base") {
    const expansion = buildings.find(([kind, t]) => kind === "CommandCenter" && t > 0)?.[1] ?? Infinity;
    if (required.slice(1).some(([, t]) => t >= expansion)) {
      throw new Error("The Terran tech must appear before the first expansion.");
    }
  }
  const beforePool = { "Zerg - 3 Hatch Before Pool": 2, "ZvP - Hatch First Macro": 1 } as Partial<Record<ScoutStrategy, number>>;
  const hatch = beforePool[strategy];
  if (hatch !== undefined && required[hatch][1] >= required[3][1]) {
    throw new Error("The selected Hatchery clue must appear before the Spawning Pool.");
  }
}

function detectorResult(raw: unknown, side: "me" | "opp") {
  const result = row(raw);
  if (result?.side !== side || !Array.isArray(result.buildings) || result.buildings.length > 1000) {
    throw new Error("The replay must provide detector and Tracker evidence for the selected side.");
  }
  const strategy = typeof result.strategy === "string" ? scoutChoices(result.strategy)?.find(choice => choice === result.strategy) : undefined;
  if (!strategy) throw new Error("Unsupported detector label.");
  return { strategy, buildings: result.buildings };
}

function sourcePlan(source: unknown) {
  const plan = row(source);
  if (plan?.consented !== true || (plan.side !== "me" && plan.side !== "opp")) {
    throw new Error("Each source needs consent and a valid replay side.");
  }
  if (Object.hasOwn(plan, "strategy") || Object.hasOwn(plan, "labelSource")) {
    throw new Error("Detector labels must come from the replay.");
  }
  const crop = cropFrom(plan.crop);
  if (!crop) throw new Error("Provide whole-number crop coordinates and a width and height of 16–256.");
  return { side: plan.side, crop } as const;
}

export function scoutPuzzleFrom(source: unknown, raw: unknown): ScoutPuzzle {
  const { side, crop } = sourcePlan(source);
  const { strategy, buildings: evidence } = detectorResult(raw, side);
  const tracked = evidence.flatMap(value => {
    const building = trackerBuilding(value, side);
    return building ? [building] : [];
  }).sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[3] - b[3] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const required = CLUES[strategy].flatMap(clue => clueBuildings(clue, tracked));
  verifyClueOrder(strategy, required, tracked);
  if ([...required, ...proxyClue(strategy, required, tracked)].some(building => !cropBuilding(building, crop))) {
    throw new Error("The crop excludes a required opening clue.");
  }
  const buildings = tracked.flatMap(building => {
    const cropped = cropBuilding(building, crop);
    return cropped ? [cropped] : [];
  });
  if (buildings.length < 3 || buildings.length > MAX_SCOUT_BUILDINGS) {
    throw new Error("The selected crop needs 3–40 supported structures by 7:30.");
  }
  return { strategy, width: crop.width, height: crop.height, buildings };
}

export function detectorLabelsMatch(source: string): boolean {
  const emitted = new Set(Array.from(source.matchAll(/^[ \t]+return "([^"\r\n]+)"[ \t]*\r?$/gm), match => match[1]));
  return SCOUT_STRATEGIES.every(group => group.every(label => emitted.has(label)));
}
