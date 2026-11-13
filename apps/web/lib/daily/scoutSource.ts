import { isScoutBuildingName, MAX_SCOUT_BUILDINGS, SCOUT_END, SCOUT_STRATEGIES, scoutChoices, type ScoutBuilding, type ScoutPuzzle } from "./scout";

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

function cropBuilding(value: unknown, side: string, crop: Crop): ScoutBuilding | null {
  const building = row(value);
  if (!building || building.owner !== side || !isScoutBuildingName(building.name)) return null;
  const { name, x, y, t } = building;
  if (!finite(x) || !finite(y) || !inOpening(t)) return null;
  const localX = x - crop.left, localY = y - crop.bottom;
  if (Math.min(localX, localY) < 0 || localX > crop.width || localY > crop.height) return null;
  // Tracker payloads have at most three decimal places. Remove subtraction artifacts.
  return [name, t, Number(localX.toFixed(3)), Number(localY.toFixed(3))];
}

function inOpening(time: unknown): time is number {
  return finite(time) && time >= 0 && time <= SCOUT_END;
}

function trackerBuildings(rawPlayback: unknown): unknown[] {
  const playback = row(rawPlayback);
  const fidelity = row(playback?.fidelity);
  if (fidelity?.positions !== "tracker" || fidelity.complete !== true || !Array.isArray(playback?.buildings) || playback.buildings.length > 1000) {
    throw new Error("Use a complete compact Tracker playback.");
  }
  return playback.buildings;
}

function sourcePlan(source: unknown) {
  const plan = row(source);
  if (plan?.consented !== true || plan.labelSource !== "detector" || (plan.side !== "me" && plan.side !== "opp")) {
    throw new Error("Each source needs consent, a detector label and a valid replay side.");
  }
  const strategy = typeof plan.strategy === "string" ? scoutChoices(plan.strategy)?.find(choice => choice === plan.strategy) : undefined;
  if (!strategy) throw new Error("Unsupported detector label.");
  const crop = cropFrom(plan.crop);
  if (!crop) throw new Error("Provide whole-number crop coordinates and a width and height of 16–256.");
  return { side: plan.side, strategy, crop };
}

export function scoutPuzzleFrom(source: unknown, rawPlayback: unknown): ScoutPuzzle {
  const { side, strategy, crop } = sourcePlan(source);
  const buildings = trackerBuildings(rawPlayback).flatMap(value => {
    const building = cropBuilding(value, side, crop);
    return building ? [building] : [];
  }).sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[3] - b[3] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (buildings.length < 3 || buildings.length > MAX_SCOUT_BUILDINGS) {
    throw new Error("The selected crop needs 3–40 supported structures in the first six minutes.");
  }
  return { strategy, width: crop.width, height: crop.height, buildings };
}

export function detectorLabelsMatch(source: string): boolean {
  const emitted = new Set(Array.from(source.matchAll(/^[ \t]+return "([^"\r\n]+)"[ \t]*\r?$/gm), match => match[1]));
  return SCOUT_STRATEGIES.every(group => group.every(label => emitted.has(label)));
}
