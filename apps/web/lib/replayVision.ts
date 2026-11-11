/**
 * replayVision — whose sight reveals the replay map.
 *
 *   both  the union of both players' vision (the replay viewer
 *         convention, and the default: nothing changes for anyone
 *         who never opens the setting)
 *   me    only your units and structures reveal the map; enemy units
 *         outside that sight are not drawn and enemy structures you
 *         scouted earlier stay as dimmed "last seen" ghosts
 *   opp   the same from the opponent's side ("what did they see?")
 *   off   no fog at all
 *
 * The playback payload carries positions, not sight. Vision here is
 * therefore ESTIMATED from fixed sight radii around each live unit and
 * structure — no high ground, detection or per-unit sight upgrades — so
 * single-side modes are always labelled approximate. When the engine
 * starts exporting observed vision (roadmap items 87/193/194), it plugs
 * in at ``visionIsObserved`` without changing any caller.
 *
 * Everything below is pure and allocation-free on the hot path: the
 * renderer stamps reveal discs into one reusable world-space grid per
 * frame and makes ONE lookup per enemy entity against it.
 */

import { isTownHall, isWorkerUnit, type MapPlayback, type PlaybackBounds } from "./mapReplay";

export type ReplayVision = "both" | "me" | "opp" | "off";

/** Cycle order for the V shortcut and the settings control. */
export const REPLAY_VISIONS: readonly ReplayVision[] = ["both", "me", "opp", "off"];

export function isReplayVision(value: unknown): value is ReplayVision {
  return value === "both" || value === "me" || value === "opp" || value === "off";
}

/** The next mode in the V cycle: both → me → opp → off → both. */
export function nextReplayVision(mode: ReplayVision): ReplayVision {
  const index = REPLAY_VISIONS.indexOf(mode);
  return REPLAY_VISIONS[(index + 1) % REPLAY_VISIONS.length];
}

/** The side whose sight alone reveals the map, or null for both/off. */
export function visionViewer(mode: ReplayVision | undefined): "me" | "opp" | null {
  return mode === "me" || mode === "opp" ? mode : null;
}

/** Plain-language mode name, with the players' labels for one side. */
export function visionLabel(mode: ReplayVision, meLabel = "You", oppLabel = "Opponent"): string {
  if (mode === "me") return meLabel;
  if (mode === "opp") return oppLabel;
  return mode === "off" ? "Off" : "Both";
}

/**
 * Extension point for engine-observed vision. Today no payload carries
 * it, so every single-side view is an estimate and says so.
 */
export function visionIsObserved(playback: Pick<MapPlayback, "fidelity">): boolean {
  const fidelity = playback.fidelity as (MapPlayback["fidelity"] & { vision?: unknown }) | undefined;
  return fidelity?.vision === "observed";
}

/**
 * Fraction of the drawn reveal radius inside which an entity counts as
 * seen. The fog stamp is solid out to 0.55 r and fades to nothing at r;
 * 0.8 r is where the fog is mostly cleared, so a unit is drawn only
 * where the map visibly reads as revealed.
 */
export const VISION_EDGE = 0.8;

/** Upper bound on grid cells; huge (hostile) bounds coarsen the cell. */
const MAX_GRID_CELLS = 1 << 20;

/**
 * World-space visibility grid. ``reset`` once per frame, ``stamp`` each
 * reveal source, then ``seen`` once per enemy entity. Cells are one
 * world unit (coarser only for absurd bounds); a cell is revealed when
 * its centre lies inside a stamped disc.
 */
export class VisionGrid {
  private cells = new Uint8Array(0);
  private cols = 0;
  private rows = 0;
  private minX = 0;
  private minY = 0;
  private cell = 1;

  reset(bounds: PlaybackBounds): void {
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    this.cell = Math.max(1, Math.ceil(Math.sqrt((width * height) / MAX_GRID_CELLS)));
    this.minX = bounds.minX;
    this.minY = bounds.minY;
    this.cols = Math.ceil(width / this.cell) + 1;
    this.rows = Math.ceil(height / this.cell) + 1;
    const size = this.cols * this.rows;
    if (this.cells.length < size) this.cells = new Uint8Array(size);
    else this.cells.fill(0, 0, size);
  }

  /** Reveal every cell whose centre is within ``r`` world units of (x, y). */
  stamp(x: number, y: number, r: number): void {
    if (!(r > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const c = this.cell;
    const r2 = r * r;
    const gy0 = Math.max(0, Math.floor((y - r - this.minY) / c));
    const gy1 = Math.min(this.rows - 1, Math.floor((y + r - this.minY) / c));
    for (let gy = gy0; gy <= gy1; gy += 1) {
      const dy = this.minY + (gy + 0.5) * c - y;
      const rest = r2 - dy * dy;
      if (rest < 0) continue;
      const half = Math.sqrt(rest);
      const gx0 = Math.max(0, Math.ceil((x - half - this.minX) / c - 0.5));
      const gx1 = Math.min(this.cols - 1, Math.floor((x + half - this.minX) / c - 0.5));
      if (gx1 < gx0) continue;
      const row = gy * this.cols;
      this.cells.fill(1, row + gx0, row + gx1 + 1);
    }
  }

  /** One lookup: is the world point inside revealed sight this frame? */
  seen(x: number, y: number): boolean {
    const gx = Math.floor((x - this.minX) / this.cell);
    const gy = Math.floor((y - this.minY) / this.cell);
    return gx >= 0 && gy >= 0 && gx < this.cols && gy < this.rows && this.cells[gy * this.cols + gx] === 1;
  }
}

export interface SightRadii {
  unit: number;
  worker: number;
  hall: number;
  building: number;
}

/** A track held at each observation until the next — the renderer's own
 *  "missing movement is held at the last observation" rule. */
function firstInRange(
  wp: readonly number[], fromT: number, untilT: number, endT: number,
  x: number, y: number, r2: number,
): number {
  for (let i = 0; i + 2 < wp.length; i += 3) {
    const t0 = wp[i];
    if (t0 >= untilT) break;
    const t1 = i + 5 < wp.length ? wp[i + 3] : endT;
    const start = Math.max(t0, fromT);
    if (start >= Math.min(t1, untilT)) continue;
    const dx = wp[i + 1] - x;
    const dy = wp[i + 2] - y;
    if (dx * dx + dy * dy <= r2) return start;
  }
  return Infinity;
}

function trackBox(wp: readonly number[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 2 < wp.length; i += 3) {
    const x = wp[i + 1], y = wp[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

type Side = "me" | "opp";
const MAX_REMEMBERED_BUILDINGS = 4096;
type SeenTimes = Record<Side, Map<string, number>>;
const segmentSight = new WeakMap<MapPlayback, { start: number; end: number; seen: SeenTimes }>();
const firstSeenCache = new WeakMap<MapPlayback, Partial<Record<Side, Float64Array>>>();

/** One bounded sight history per open, verified playback. Decoded section
 * objects can be evicted without losing their earlier sightings. */
export class ReplaySightHistory {
  private readonly seen: SeenTimes = { me: new Map(), opp: new Map() };

  addWindow(playback: MapPlayback, start: number, end: number): void {
    segmentSight.set(playback, { start, end, seen: this.seen });
  }
}

export function structureSeenAt(playback: MapPlayback, viewer: Side, index: number, local: Float64Array): number {
  const id = playback.buildings[index]?.id;
  const earlier = id !== undefined ? segmentSight.get(playback)?.seen[viewer].get(String(id)) : undefined;
  return Math.min(local[index], earlier ?? Infinity);
}

/**
 * When ``viewer`` first had (estimated) sight of each ENEMY structure,
 * in game seconds; Infinity when never. Indexed like
 * ``playback.buildings``; the viewer's own structures are 0 (always
 * known). Computed once per payload and side, on first use: each
 * friendly unit's track is held between observations and tested only
 * against structures inside its bounding box, so a whole game costs a
 * few milliseconds.
 */
export function buildingFirstSeen(
  playback: MapPlayback,
  viewer: "me" | "opp",
  sight: SightRadii,
  edge = VISION_EDGE,
): Float64Array {
  let bySide = firstSeenCache.get(playback);
  const cached = bySide?.[viewer];
  if (cached) return cached;
  const buildings = playback.buildings;
  const seenAt = new Float64Array(buildings.length).fill(Infinity);
  const enemy: number[] = [];
  buildings.forEach((b, i) => { if (b.owner === viewer) seenAt[i] = 0; else enemy.push(i); });
  const window = segmentSight.get(playback);
  const start = window?.start ?? 0;
  const end = window?.end ?? Math.max(playback.gameLength, 0);
  const consider = (wp: readonly number[], born: number, died: number | null, r: number) => {
    if (wp.length < 3) return;
    const [minX, minY, maxX, maxY] = trackBox(wp);
    const r2 = r * r;
    for (const bi of enemy) {
      const b = buildings[bi];
      if (b.x < minX - r || b.x > maxX + r || b.y < minY - r || b.y > maxY + r) continue;
      const until = Math.min(died ?? Infinity, b.died ?? Infinity, seenAt[bi], end);
      const at = firstInRange(wp, Math.max(born, b.t, start), until, died ?? end, b.x, b.y, r2);
      if (at < seenAt[bi]) seenAt[bi] = at;
    }
  };
  for (const u of playback.units) {
    if (u.owner !== viewer) continue;
    consider(u.wp, u.born, u.died, (isWorkerUnit(u.name) ? sight.worker : sight.unit) * edge);
  }
  for (const b of buildings) {
    if (b.owner !== viewer) continue;
    const r = (isTownHall(b.name) ? sight.hall : sight.building) * edge;
    consider([b.t, b.x, b.y, ...b.moves], b.t, b.died, r);
  }
  if (window) {
    const seen = window.seen[viewer];
    for (const i of enemy) {
      const tag = buildings[i].id;
      if (tag === undefined || !Number.isFinite(seenAt[i])) continue;
      const id = String(tag);
      const previous = seen.get(id);
      if (seenAt[i] >= (previous ?? Infinity)) continue;
      if (previous !== undefined || seen.size < MAX_REMEMBERED_BUILDINGS) seen.set(id, seenAt[i]);
    }
  }
  bySide = bySide ?? {};
  bySide[viewer] = seenAt;
  firstSeenCache.set(playback, bySide);
  return seenAt;
}
