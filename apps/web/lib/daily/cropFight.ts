import {
  unitMaxSpeed, unitNameAt, unitPositionAt, type PlaybackBounds, type PlaybackUnit,
} from "../mapReplay";
import { unitCost } from "../mapReplayLosses";
import type { PatchEra } from "../meta";
import { CLIP_SECONDS, type DailyUnit } from "./clip";

export type Point = { x: number; y: number };
export type FightWindow = { start: number; end: number; bounds: PlaybackBounds };

export function inside(point: Point, bounds: PlaybackBounds): boolean {
  return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;
}

export function observedPoint(unit: PlaybackUnit, time: number): Point | null {
  return unitPositionAt(unit.wp, time, unitMaxSpeed(unitNameAt(unit, time), true));
}

function clipTime(time: number, start: number): number {
  return Math.max(0, Math.min(CLIP_SECONDS, time - start));
}

function coordinate(value: number, min: number, max: number): number {
  return Math.min(max - min, Math.max(0, Math.round((value - min) * 100) / 100));
}

function localPoint(point: Point, bounds: PlaybackBounds): [number, number] {
  return [coordinate(point.x, bounds.minX, bounds.maxX), coordinate(point.y, bounds.minY, bounds.maxY)];
}

function cropGaps(gaps: readonly number[], from: number, until: number, start: number): number[] {
  const ranges: [number, number][] = [];
  for (let i = 0; i + 1 < gaps.length; i += 2) {
    const min = Math.max(from, gaps[i]), max = Math.min(until, gaps[i + 1]);
    if (min < max) ranges.push([min, max]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: number[] = [];
  for (const [min, max] of ranges) {
    const last = merged.length - 1;
    const begin = clipTime(min, start), end = clipTime(max, start);
    if (last >= 0 && merged[last] >= begin) merged[last] = Math.max(merged[last], end);
    else if (begin < end) merged.push(begin, end);
  }
  return merged;
}

function trackTimes(unit: PlaybackUnit, from: number, until: number): number[] {
  const times = [from];
  for (let i = 0; i < unit.wp.length; i += 3) {
    if (unit.wp[i] > from && unit.wp[i] < until) times.push(unit.wp[i]);
  }
  times.push(until);
  return times;
}

function croppedTrack(unit: PlaybackUnit, from: number, until: number, window: FightWindow) {
  const { bounds, start } = window;
  const path: number[] = [], outside: number[] = [];
  let visible = false, hiddenFrom: number | null = null;
  for (const time of trackTimes(unit, from, until)) {
    const point = observedPoint(unit, time);
    if (!point) return null;
    if (inside(point, bounds)) {
      visible = true;
      if (hiddenFrom !== null) outside.push(hiddenFrom, time);
      hiddenFrom = null;
    } else hiddenFrom ??= time;
    path.push(clipTime(time, start), ...localPoint(point, bounds));
  }
  if (!visible) return null;
  if (hiddenFrom !== null) outside.push(hiddenFrom, until);
  return { path, gaps: cropGaps([...(unit.hidden ?? []), ...outside], from, until, start) };
}

function cropAim(values: readonly number[], from: number, until: number, window: FightWindow): number[] {
  const aim: number[] = [];
  for (let i = 0; i + 2 < values.length; i += 3) {
    const time = values[i], point = { x: values[i + 1], y: values[i + 2] };
    if (time >= from && time <= until && inside(point, window.bounds)) {
      aim.push(clipTime(time, window.start), ...localPoint(point, window.bounds));
    }
  }
  return aim;
}

export function cropUnit(unit: PlaybackUnit, window: FightWindow, swapped: boolean, era: PatchEra): DailyUnit | null {
  const { start, end } = window;
  const from = Math.max(start, unit.born), until = Math.min(end, unit.died ?? end);
  if (from >= until) return null;
  const name = unitNameAt(unit, from);
  if (!unitCost(name, era)) return null;
  const clipped = croppedTrack(unit, from, until, window);
  if (!clipped) return null;
  const shots = (unit.attacks ?? []).filter(time => time >= from && time <= until).map(time => clipTime(time, start));
  const aim = cropAim(unit.aim ?? [], from, until, window);
  const forms = (unit.forms ?? [])
    .filter(form => form.t > from && form.t <= until && unitCost(form.name, era))
    .map(form => ({ at: clipTime(form.t, start), unit: form.name }));
  return {
    side: (unit.owner === "me") !== swapped ? 0 : 1,
    unit: name,
    from: clipTime(from, start),
    until: unit.died === until ? clipTime(until, start) : null,
    path: clipped.path,
    shots, aim, forms, gaps: clipped.gaps,
  };
}
