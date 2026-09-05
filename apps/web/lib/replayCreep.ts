/**
 * Creep coverage reconstructed from recorded, stationary creep sources.
 *
 * Tracker replay events contain hatchery/tumor lifetimes, but no creep bitmap.
 * These envelopes are deliberately an estimate: terrain, creep blockers,
 * overlord drops, growth ticks and exact decay require SC2 engine observations.
 * Never use this layer for path finding or label it as observed coverage.
 */
import type { MapPlayback, PlaybackBounds } from "./mapReplay";
import { projectX, projectY } from "./mapReplay";

export interface CreepSource {
  owner: "me" | "opp";
  kind: "hall" | "tumor";
  x: number;
  y: number;
  born: number;
  died: number | null;
}

export interface CreepPatch extends CreepSource {
  radius: number;
}

// Presentation envelopes, not a substitute for the engine's creep simulation.
const HALL_RADIUS = 12;
const TUMOR_RADIUS = 10;
const HALL_GROWTH_SECONDS = 60;
const TUMOR_GROWTH_SECONDS = 30;
export const ESTIMATED_CREEP_DECAY_SECONDS = 30;

function sourceKind(name: string): CreepSource["kind"] | null {
  const key = name.replace(/[\s_-]/g, "").toLowerCase();
  if (["hatchery", "lair", "hive"].includes(key)) return "hall";
  if (["creeptumor", "creeptumorqueen", "creeptumorburrowed"].includes(key)) return "tumor";
  return null;
}

/** Derive once per payload. Moving queens/overlords do not imply creep. */
export function collectCreepSources(playback: Pick<MapPlayback, "buildings" | "units">): CreepSource[] {
  const sources: CreepSource[] = [];
  function add(source: CreepSource): void {
    if (![source.x, source.y, source.born].every(Number.isFinite)) return;
    if (source.died !== null && (!Number.isFinite(source.died) || source.died < source.born)) return;
    // Legacy payloads can include the same tumor in both collections. Match
    // location AND lifetime so a destroyed/rebuilt hall stays a separate source.
    const duplicate = sources.some((other) => other.kind === source.kind &&
      other.owner === source.owner && Math.abs(other.born - source.born) < 0.1 &&
      Math.hypot(other.x - source.x, other.y - source.y) < 0.1);
    if (!duplicate) sources.push(source);
  }
  for (const building of playback.buildings) {
    const kind = sourceKind(building.name);
    if (kind) add({ owner: building.owner, kind, x: building.x, y: building.y,
      born: building.t, died: building.died });
  }
  for (const unit of playback.units) {
    const kind = sourceKind(unit.name);
    if (!kind || unit.wp.length < 3) continue;
    // These are stationary entities. Using later waypoints would make the
    // footprint drift when an old payload contains a spurious command target.
    add({ owner: unit.owner, kind, x: unit.wp[1], y: unit.wp[2],
      born: unit.born, died: unit.died });
  }
  return sources.sort((a, b) => a.born - b.born || a.x - b.x || a.y - b.y);
}

/** Stateless sampling makes seeking backwards identical to forward playback. */
export function estimatedCreepRadiusAt(source: CreepSource, t: number): number {
  if (!Number.isFinite(t) || t < source.born) return 0;
  const maxRadius = source.kind === "hall" ? HALL_RADIUS : TUMOR_RADIUS;
  const growthSeconds = source.kind === "hall" ? HALL_GROWTH_SECONDS : TUMOR_GROWTH_SECONDS;
  // Starting halls arrive with established creep. Newly planted sources grow
  // from their recorded birth; growth stops when the source is destroyed.
  const growthTime = Math.max(0, Math.min(t, source.died ?? t) - source.born);
  const grown = source.born <= 0 && source.kind === "hall"
    ? maxRadius : maxRadius * Math.min(1, growthTime / growthSeconds);
  const decay = source.died === null || t <= source.died
    ? 1 : Math.max(0, 1 - (t - source.died) / ESTIMATED_CREEP_DECAY_SECONDS);
  return grown * decay;
}

export function creepPatchesAt(sources: readonly CreepSource[], t: number): CreepPatch[] {
  const patches: CreepPatch[] = [];
  for (const source of sources) {
    if (source.born > t) continue;
    const radius = estimatedCreepRadiusAt(source, t);
    if (radius > 0) patches.push({ ...source, radius });
  }
  return patches;
}

/** Stable organic contour. It never changes a source's recorded location. */
function appendPatch(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  phase: number,
): void {
  const segments = 48;
  for (let i = 0; i < segments; i += 1) {
    const angle = i * Math.PI * 2 / segments;
    const edge = 0.95 + 0.03 * Math.sin(angle * 5 + phase) + 0.02 * Math.sin(angle * 9 - phase);
    const px = x + Math.cos(angle) * radius * edge;
    const py = y + Math.sin(angle) * radius * edge;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** Draw under furniture/entities, within the caller's world/view transform. */
export function drawEstimatedCreep(
  ctx: CanvasRenderingContext2D,
  bounds: PlaybackBounds,
  projection: { k: number; ox: number; oy: number },
  sources: readonly CreepSource[],
  t: number,
): void {
  if (sources.length === 0 || !(projection.k > 0)) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(projection.ox, projection.oy,
    (bounds.maxX - bounds.minX) * projection.k,
    (bounds.maxY - bounds.minY) * projection.k);
  ctx.clip();
  // One nonzero-winding fill per layer unions overlapping patches without
  // darkening intersections, so dense tumors don't create opaque purple discs.
  for (const layer of [1, 0.86]) {
    ctx.beginPath();
    let any = false;
    for (const source of sources) {
      const radius = estimatedCreepRadiusAt(source, t);
      if (!(radius > 0)) continue;
      any = true;
      appendPatch(ctx, projectX(bounds, projection, source.x), projectY(bounds, projection, source.y),
        radius * projection.k * layer, source.x * 0.73 + source.y * 1.19);
    }
    if (any) {
      ctx.fillStyle = layer === 1 ? "rgba(91, 44, 121, 0.28)" : "rgba(82, 39, 107, 0.24)";
      ctx.fill();
    }
  }
  ctx.restore();
}
