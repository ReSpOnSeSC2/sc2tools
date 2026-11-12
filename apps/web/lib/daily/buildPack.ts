import {
  buildingPositionAt, isWorkerUnit, unitNameAt, unitVisibleAt,
  type MapPlayback, type PlaybackBounds, type PlaybackBuilding, type PlaybackUnit,
} from "../mapReplay";
import { computeLosses, lossValue, morphConsumedIndices, unitCost } from "../mapReplayLosses";
import type { PatchEra } from "../meta";
import { CLIP_SECONDS, isDailyFight, type DailyFight } from "./clip";
import { cropUnit, inside, observedPoint, type FightWindow, type Point } from "./cropFight";
import { unambiguousTrade } from "./rules";

const CROP_WIDTH = 36;
const CROP_HEIGHT = 24;
const FREEZE_LEAD = 1;
const LOCAL_CONTACT_RADIUS = 12;
const MIN_TRADE_VALUE = 150;
const SAME_FIGHT_GAP = 3;
const MIN_CONCENTRATION = 0.8;
const MAX_WORKER_SHARE = 0.15;

type Contact = Point & { time: number };
type Death = Contact & { unit: PlaybackUnit; value: number; worker: boolean };
type RecordingRange = { start: number; end: number };
export type FightDraft = { fight: DailyFight; bounds: PlaybackBounds };

function contactEvents(playback: MapPlayback): Contact[] {
  const events: Contact[] = [];
  for (const unit of playback.units) {
    const aims = new Map<number, Point>();
    const recorded = unit.aim ?? [];
    for (let i = 0; i + 2 < recorded.length; i += 3) {
      aims.set(recorded[i], { x: recorded[i + 1], y: recorded[i + 2] });
    }
    for (const time of unit.attacks ?? []) {
      if (isWorkerUnit(unitNameAt(unit, time))) continue;
      const point = aims.get(time) ?? observedPoint(unit, time);
      if (point) events.push({ ...point, time });
    }
  }
  return events.sort((a, b) => a.time - b.time);
}

function deathEvents(playback: MapPlayback, era: PatchEra): Death[] {
  const consumed = morphConsumedIndices(playback.units, playback.buildings, playback.v);
  return playback.units.flatMap((unit, index) => {
    if (unit.died === null || consumed.has(index)) return [];
    const name = unitNameAt(unit, unit.died), cost = unitCost(name, era);
    const point = observedPoint(unit, unit.died);
    return cost && point ? [{ ...point, time: unit.died, unit,
      value: cost.minerals + cost.gas, worker: isWorkerUnit(name) }] : [];
  });
}

function cropAround(center: Point, whole: PlaybackBounds): PlaybackBounds {
  const width = Math.min(CROP_WIDTH, whole.maxX - whole.minX);
  const height = Math.min(CROP_HEIGHT, whole.maxY - whole.minY);
  const minX = Math.max(whole.minX, Math.min(whole.maxX - width, center.x - width / 2));
  const minY = Math.max(whole.minY, Math.min(whole.maxY - height, center.y - height / 2));
  return { minX, minY, maxX: minX + width, maxY: minY + height };
}

function measuredLosses(deaths: readonly Death[], window: FightWindow, era: PatchEra) {
  const events = deaths.filter(death => death.time >= window.start && death.time <= window.end);
  const local = events.filter(death => inside(death, window.bounds));
  if (local.some(death => death.time < window.start + FREEZE_LEAD)) return null;
  const allValue = events.reduce((sum, death) => sum + death.value, 0);
  const localValue = local.reduce((sum, death) => sum + death.value, 0);
  const workers = local.reduce((sum, death) => sum + (death.worker ? death.value : 0), 0);
  if (localValue < MIN_TRADE_VALUE || localValue < allValue * MIN_CONCENTRATION ||
      workers > localValue * MAX_WORKER_SHARE) return null;
  const units = local.map(death => death.unit);
  const mine = lossValue(computeLosses(units, "me", window.end, undefined, era));
  const theirs = lossValue(computeLosses(units, "opp", window.end, undefined, era));
  return unambiguousTrade(mine, theirs) ? { mine, theirs } : null;
}

function earlierContact(events: readonly Contact[], index: number): boolean {
  const contact = events[index];
  for (let prior = index - 1; prior >= 0 && events[prior].time >= contact.time - SAME_FIGHT_GAP; prior--) {
    if (Math.hypot(events[prior].x - contact.x, events[prior].y - contact.y) <= LOCAL_CONTACT_RADIUS) return true;
  }
  return false;
}

function bothArmies(playback: MapPlayback, window: FightWindow, era: PatchEra): boolean {
  const armies = new Set<string>();
  for (const unit of playback.units) {
    if (!unitVisibleAt(unit, window.start)) continue;
    const name = unitNameAt(unit, window.start);
    if (isWorkerUnit(name) || !unitCost(name, era)) continue;
    const point = observedPoint(unit, window.start);
    if (point && inside(point, window.bounds)) armies.add(unit.owner);
  }
  return armies.size === 2;
}

function inWindow(time: number, { start, end }: FightWindow): boolean {
  return time >= start && time <= end;
}

function structureInvolved(building: PlaybackBuilding, window: FightWindow): boolean {
  const { bounds } = window;
  const death = building.died;
  if (death !== null && inWindow(death, window) &&
      inside(buildingPositionAt(building, death, true), bounds)) return true;
  const aim = building.aim ?? [];
  for (let i = 0; i + 2 < aim.length; i += 3) {
    if (inWindow(aim[i], window) && inside({ x: aim[i + 1], y: aim[i + 2] }, bounds)) return true;
  }
  return (building.attacks ?? []).some(time => inWindow(time, window) &&
    inside(buildingPositionAt(building, time, true), bounds));
}

function buildFight(playback: MapPlayback, deaths: readonly Death[], window: FightWindow, era: PatchEra, swapped: boolean): FightDraft | null {
  if (playback.buildings.some(building => structureInvolved(building, window))) return null;
  const losses = measuredLosses(deaths, window, era);
  if (!losses || !bothArmies(playback, window, era)) return null;
  const units = playback.units.flatMap(unit => {
    const cropped = cropUnit(unit, window, swapped, era);
    return cropped ? [cropped] : [];
  });
  const { minX, maxX, minY, maxY } = window.bounds;
  const fight: DailyFight = {
    width: maxX - minX, height: maxY - minY, units,
    losses: swapped ? [losses.theirs, losses.mine] : [losses.mine, losses.theirs],
    terrain: false,
  };
  return isDailyFight(fight) ? { bounds: window.bounds, fight } : null;
}

/** One complete observed segment. A fight crossing its edge is left out. */
export function selectFights(playback: MapPlayback, range: RecordingRange, era: PatchEra, seed: number): FightDraft[] {
  if (!completeRecording(playback.fidelity)) return [];
  const contacts = contactEvents(playback), deaths = deathEvents(playback, era);
  const fights: FightDraft[] = [];
  // At a segment boundary, shots from the preceding segment are unavailable.
  let next = range.start > 0 ? range.start + SAME_FIGHT_GAP : FREEZE_LEAD;
  for (const [index, contact] of contacts.entries()) {
    const start = contact.time - FREEZE_LEAD, end = start + CLIP_SECONDS;
    if (end > range.end) break;
    if (contact.time < next || earlierContact(contacts, index)) continue;
    const bounds = cropAround(contact, playback.bounds);
    const swapped = ((Math.round(contact.time * 100) + seed) & 1) === 1;
    const draft = buildFight(playback, deaths, { start, end, bounds }, era, swapped);
    if (draft) {
      fights.push(draft);
      next = end + SAME_FIGHT_GAP;
    } else next = contact.time + 0.5;
  }
  return fights;
}

function completeRecording(fidelity: MapPlayback["fidelity"]): boolean {
  return fidelity?.positions === "engine" && fidelity.attacks === "observed" && fidelity.complete === true;
}
