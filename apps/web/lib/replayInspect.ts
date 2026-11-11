/**
 * replayInspect — click-to-inspect and follow for the map replayer.
 *
 * The renderer records every LIVE entity it actually drew (after vision
 * filtering, so a hidden enemy can never be clicked) into a pooled hit
 * buffer in canvas CSS pixels. A tap then hit-tests that buffer:
 * the nearest entity whose radius contains the point wins, and tapping
 * the same spot again cycles through the overlapping ones — a Marine
 * standing on a Barracks is reachable without zooming.
 *
 * Follow keeps a unit centred by recomputing the view transform each
 * frame from the unit's own sampled position; it ends when the unit
 * dies or disappears (cargo), and the host releases it on Escape.
 *
 * Pure functions over the payload; no React, no canvas.
 */

import {
  buildingAliveAt, buildingPositionAt, buildingVisibleAt, projectX, projectY, unitAliveAt, unitMaxSpeed,
  unitNameAt, unitPositionAt, unitVisibleAt, worldProjection, type MapPlayback,
} from "./mapReplay";

export type ReplayEntityKind = "unit" | "building";
export interface ReplayEntityRef { kind: ReplayEntityKind; index: number }
export interface ReplayView { z: number; ox: number; oy: number }

/** Smallest tap radius in CSS px, so tiny sprites stay tappable on phones. */
export const MIN_HIT_RADIUS_PX = 12;
/** A second tap within this many px of the first cycles the overlap. */
export const CYCLE_SLOP_PX = 6;
/** Zoom a follow starts at when the map is fully zoomed out. */
export const FOLLOW_MIN_ZOOM = 2.5;

/** Structure-of-arrays hit records of the last drawn frame, reused. */
export interface ReplayHitBuffer {
  count: number;
  x: number[];
  y: number[];
  r: number[];
  kind: ReplayEntityKind[];
  index: number[];
}

export function createHitBuffer(): ReplayHitBuffer {
  return { count: 0, x: [], y: [], r: [], kind: [], index: [] };
}

export function pushHit(buffer: ReplayHitBuffer, x: number, y: number, r: number, kind: ReplayEntityKind, index: number): void {
  const i = buffer.count;
  buffer.x[i] = x;
  buffer.y[i] = y;
  buffer.r[i] = Math.max(MIN_HIT_RADIUS_PX, r);
  buffer.kind[i] = kind;
  buffer.index[i] = index;
  buffer.count = i + 1;
}

export function sameEntity(a: ReplayEntityRef | null | undefined, b: ReplayEntityRef | null | undefined): boolean {
  return !!a && !!b && a.kind === b.kind && a.index === b.index;
}

/** Every recorded entity, nearest to (px, py) first; ``within`` keeps only
 *  those whose radius contains the point. Ties break on kind, then index,
 *  so the order never depends on the draw order. */
export function hitsByDistance(buffer: ReplayHitBuffer, px: number, py: number, within = true): ReplayEntityRef[] {
  const found: { d: number; ref: ReplayEntityRef }[] = [];
  for (let i = 0; i < buffer.count; i += 1) {
    const d = Math.hypot(buffer.x[i] - px, buffer.y[i] - py);
    if (within && d > buffer.r[i]) continue;
    found.push({ d, ref: { kind: buffer.kind[i], index: buffer.index[i] } });
  }
  found.sort((a, b) => a.d - b.d || (a.ref.kind === b.ref.kind ? a.ref.index - b.ref.index : a.ref.kind === "unit" ? -1 : 1));
  return found.map((entry) => entry.ref);
}

/**
 * The entity a tap at (px, py) selects. A repeat tap near ``previous``
 * whose selection is still under the point advances to the next
 * overlapping entity, wrapping around.
 */
export function hitTest(
  buffer: ReplayHitBuffer,
  px: number,
  py: number,
  previous?: { ref: ReplayEntityRef | null; x: number; y: number } | null,
): ReplayEntityRef | null {
  const candidates = hitsByDistance(buffer, px, py);
  if (!candidates.length) return null;
  if (previous?.ref && Math.hypot(previous.x - px, previous.y - py) <= CYCLE_SLOP_PX) {
    const at = candidates.findIndex((ref) => sameEntity(ref, previous.ref));
    if (at >= 0) return candidates[(at + 1) % candidates.length];
  }
  return candidates[0];
}

/** Keyboard inspection: the next entity outward from the view centre. */
export function nextNearest(buffer: ReplayHitBuffer, px: number, py: number, current: ReplayEntityRef | null): ReplayEntityRef | null {
  const ordered = hitsByDistance(buffer, px, py, false);
  if (!ordered.length) return null;
  const at = current ? ordered.findIndex((ref) => sameEntity(ref, current)) : -1;
  return ordered[(at + 1) % ordered.length];
}

export interface InspectedEntity {
  ref: ReplayEntityRef;
  /** The form at ``t`` (a Lair stays a Lair after its Hatchery start). */
  name: string;
  owner: "me" | "opp";
  born: number;
  died: number | null;
  /** Seconds on the map, to its death or the end of the recording. */
  lifetime: number;
  /** Observed weapon cycles; null when this payload has no attack data. */
  attacks: number | null;
  alive: boolean;
  /** Alive and on the map (not loaded in a transport). */
  visible: boolean;
}

export function inspectEntity(playback: MapPlayback, ref: ReplayEntityRef, t: number): InspectedEntity | null {
  const observedAttacks = playback.fidelity?.attacks === "observed";
  if (ref.kind === "unit") {
    const u = playback.units[ref.index];
    if (!u) return null;
    return {
      ref, name: unitNameAt(u, t), owner: u.owner, born: u.born, died: u.died,
      lifetime: Math.max(0, (u.died ?? playback.gameLength) - u.born),
      attacks: observedAttacks ? u.attacks?.length ?? 0 : null,
      alive: unitAliveAt(u, t), visible: unitVisibleAt(u, t),
    };
  }
  const b = playback.buildings[ref.index];
  if (!b) return null;
  return {
    ref, name: unitNameAt(b, t), owner: b.owner, born: b.t, died: b.died,
    lifetime: Math.max(0, (b.died ?? playback.gameLength) - b.t),
    attacks: observedAttacks ? b.attacks?.length ?? 0 : null,
    alive: buildingAliveAt(b, t), visible: buildingVisibleAt(b, t),
  };
}

/**
 * Carry a selection into another payload of the same game (the next
 * segment) by its stable replay id. Payloads without ids lose it.
 */
export function resolveEntity(previous: MapPlayback, next: MapPlayback, ref: ReplayEntityRef): ReplayEntityRef | null {
  if (previous === next) return ref;
  const from = ref.kind === "unit" ? previous.units[ref.index] : previous.buildings[ref.index];
  const id = from?.id;
  if (id === undefined || id === null) return null;
  const list: readonly { id?: unknown }[] = ref.kind === "unit" ? next.units : next.buildings;
  const index = list.findIndex((entity) => entity.id === id);
  return index >= 0 ? { kind: ref.kind, index } : null;
}

/** World position of a live, on-map entity at ``t``; null once it is gone. */
export function entityPositionAt(playback: MapPlayback, ref: ReplayEntityRef, t: number): { x: number; y: number } | null {
  const engine = playback.fidelity?.positions === "engine";
  if (ref.kind === "unit") {
    const u = playback.units[ref.index];
    if (!u || !unitVisibleAt(u, t)) return null;
    return unitPositionAt(u.wp, t, unitMaxSpeed(unitNameAt(u, t), engine));
  }
  const b = playback.buildings[ref.index];
  if (!b || !buildingVisibleAt(b, t)) return null;
  return buildingPositionAt(b, t, engine);
}

/**
 * The view transform that centres ``ref`` on a ``w``×``h`` canvas,
 * zoomed in to at least ``minZoom`` and clamped exactly like a manual
 * pan, so the map edge never scrolls into view. Null once the entity is
 * gone, which is the host's cue to end the follow.
 */
export function followView(
  playback: MapPlayback, ref: ReplayEntityRef, t: number, view: ReplayView,
  w: number, h: number, pad: number, minZoom = FOLLOW_MIN_ZOOM,
): ReplayView | null {
  const pos = entityPositionAt(playback, ref, t);
  if (!pos || !(w > 0) || !(h > 0)) return null;
  const proj = worldProjection(playback.bounds, w, h, pad);
  if (!(proj.k > 0)) return null;
  const z = Math.min(8, Math.max(view.z, minZoom));
  const sx = projectX(playback.bounds, proj, pos.x);
  const sy = projectY(playback.bounds, proj, pos.y);
  return {
    z,
    ox: Math.min(0, Math.max(w - w * z, w / 2 - sx * z)),
    oy: Math.min(0, Math.max(h - h * z, h / 2 - sy * z)),
  };
}
