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
export type AttentionSection = Window & { playback: MapPlayback };
export type ReadAttentionSections = (signal: AbortSignal) => AsyncIterable<AttentionSection>;
type FightAttention = { time: number; lookedAway: boolean | null };
type CameraTrack = readonly number[];
type Counts = { grid: Uint32Array; samples: number; nearArmy: number; nearBase: number; fights: FightAttention[] };
const emptyCounts = (): Counts => ({ grid: new Uint32Array(GRID * GRID), samples: 0, nearArmy: 0, nearBase: 0, fights: [] });

function finish(counts: Counts, interval: number) {
  return counts.samples ? { ...counts, interval, nearArmy: Math.round(100 * counts.nearArmy / counts.samples),
    nearBase: Math.round(100 * counts.nearBase / counts.samples) } : null;
}

/** Work is bounded even for hours-long replays. Fight lookbacks still use one-second steps. */
export function replayAttention(playback: MapPlayback, side: Side, window?: Window) {
  const section = window ?? { start: 0, end: playback.gameLength };
  const interval = Math.max(1, Math.ceil((section.end - section.start) / 600));
  const counts = emptyCounts();
  measureSection(counts, playback, side, section, interval, () => null);
  return finish(counts, interval);
}

function measureSection(counts: Counts, playback: MapPlayback, side: Side, { start, end }: Window, interval: number,
  earlierCamera: (time: number) => CameraPoint | null) {
  const track = playback.camera?.[side];
  if (!track?.length) return;
  const firstSample = Math.ceil(Math.max(start, track[0]) / interval) * interval;
  const { bounds } = playback;
  const observed = playback.fidelity?.positions === "engine";
  const bases = playback.buildings.filter(building => building.owner === side && isTownHall(building.name));
  const army = playback.units.filter(unit => unit.owner === side && !isWorkerUnit(unit.name))
    .map(unit => ({ unit, speed: unitMaxSpeed(unit.name, observed) }));
  for (let time = firstSample; time < end; time += interval) {
    const camera = replayCameraAt(track, time);
    if (!camera) continue;
    counts.samples++;
    const column = cell((camera.x - bounds.minX) / (bounds.maxX - bounds.minX));
    const row = cell((bounds.maxY - camera.y) / (bounds.maxY - bounds.minY));
    counts.grid[row * GRID + column]++;
    if (bases.some(base => buildingVisibleAt(base, time) && inside(camera, buildingPositionAt(base, time, observed)))) counts.nearBase++;
    let x = 0, y = 0, count = 0;
    for (const { unit, speed } of army) {
      if (!unitVisibleAt(unit, time)) continue;
      const position = unitPositionAt(unit.wp, time, speed);
      if (position) { x += position.x; y += position.y; count++; }
    }
    if (count && inside(camera, { x: x / count, y: y / count })) counts.nearArmy++;
  }
  for (const fight of playback.battles) {
    if (fight.t < start || fight.t >= end) continue;
    const cameras = Array.from({ length: 5 }, (_, offset) => {
      const time = fight.t - 5 + offset;
      return time >= start ? replayCameraAt(track, time) : earlierCamera(time);
    });
    const watched = cameras.some(point => point && inside(point, fight));
    counts.fights.push({ time: fight.t, lookedAway: watched ? false : cameras.every(Boolean) ? true : null });
  }
}

/** Visit windows in game order, retaining the five-second seam and counts.
 * Every section uses the same game-time sample grid. */
export async function fullReplayAttention(sections: AsyncIterable<AttentionSection>, gameLength: number, signal: AbortSignal) {
  const interval = Math.max(1, Math.ceil(gameLength / 600));
  const counts = { me: emptyCounts(), opp: emptyCounts() };
  let recent: (Window & { camera?: Partial<Record<Side, CameraTrack>> })[] = [];
  for await (const { start, end, playback } of sections) {
    signal.throwIfAborted();
    recent = recent.filter(section => section.end > start - 5);
    for (const side of ["me", "opp"] as const) {
      measureSection(counts[side], playback, side, { start, end }, interval, time => {
        const track = recent.find(section => time >= section.start && time < section.end)?.camera?.[side];
        return track ? replayCameraAt(track, time) : null;
      });
    }
    recent.push({ start, end, camera: playback.camera });
  }
  signal.throwIfAborted();
  return { me: finish(counts.me, interval), opp: finish(counts.opp, interval) };
}
