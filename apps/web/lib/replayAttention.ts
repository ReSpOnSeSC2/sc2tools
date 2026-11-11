import {
  buildingPositionAt, buildingVisibleAt, isTownHall, isWorkerUnit, unitMaxSpeed, unitPositionAt, unitVisibleAt, type MapPlayback,
} from "./mapReplay";
import { replayCameraAt, type CameraPoint } from "./replayCamera";

const GRID = 64;
const RADIUS = 20;
const inside = (a: CameraPoint, b: CameraPoint) => Math.hypot(a.x - b.x, a.y - b.y) <= RADIUS;
const cell = (fraction: number) => Math.max(0, Math.min(GRID - 1, Math.floor(fraction * GRID)));
type Side = "me" | "opp";
type Window = { start: number; end: number };

/** Work is bounded even for hours-long replays. Fight lookbacks still use one-second steps. */
export function replayAttention(playback: MapPlayback, side: Side, window?: Window) {
  const track = playback.camera?.[side];
  if (!track?.length) return null;
  const start = Math.max(Math.ceil(window?.start ?? 0), Math.ceil(track[0]));
  const end = window?.end ?? playback.gameLength;
  const interval = Math.max(1, Math.ceil((end - start) / 600));
  const { bounds } = playback;
  const observed = playback.fidelity?.positions === "engine";
  const bases = playback.buildings.filter(building => building.owner === side && isTownHall(building.name));
  const army = playback.units.filter(unit => unit.owner === side && !isWorkerUnit(unit.name))
    .map(unit => ({ unit, speed: unitMaxSpeed(unit.name, observed) }));
  const grid = new Uint32Array(GRID * GRID);
  let samples = 0, nearArmy = 0, nearBase = 0;
  for (let time = start; time < end; time += interval) {
    const camera = replayCameraAt(track, time);
    if (!camera) continue;
    samples++;
    const column = cell((camera.x - bounds.minX) / (bounds.maxX - bounds.minX));
    const row = cell((bounds.maxY - camera.y) / (bounds.maxY - bounds.minY));
    grid[row * GRID + column]++;
    if (bases.some(base => buildingVisibleAt(base, time) && inside(camera, buildingPositionAt(base, time, observed)))) nearBase++;
    let x = 0, y = 0, count = 0;
    for (const { unit, speed } of army) {
      if (!unitVisibleAt(unit, time)) continue;
      const position = unitPositionAt(unit.wp, time, speed);
      if (position) { x += position.x; y += position.y; count++; }
    }
    if (count && inside(camera, { x: x / count, y: y / count })) nearArmy++;
  }
  if (!samples) return null;
  const fights = playback.battles.filter(fight => fight.t >= (window?.start ?? 0) && fight.t < end).map(fight => {
    if (fight.t - 5 < start) return { time: fight.t, lookedAway: null };
    const watched = Array.from({ length: 5 }, (_, offset) => replayCameraAt(track, fight.t - 5 + offset))
      .some(point => point && inside(point, fight));
    return { time: fight.t, lookedAway: !watched };
  });
  return { grid, samples, interval, nearArmy: Math.round(100 * nearArmy / samples), nearBase: Math.round(100 * nearBase / samples), fights };
}
