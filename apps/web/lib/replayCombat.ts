import {
  buildingAliveAt, buildingPositionAt, projectX, projectY, unitNameAt,
  unitPositionAt, unitVisibleAt, type MapPlayback,
} from "./mapReplay";
import { facingFromVelocity } from "./replayMotion";

export interface WeaponTrack { attacks?: readonly number[]; aim?: readonly number[] }
export interface AttackSample { t: number; age: number; x: number | null; y: number | null }

/** A weapon cycle is recorded by the engine, never inferred from an order,
 * nearby enemies, or a battle marker. Binary lookups support reverse seeks. */
export function attackAt(entity: WeaponTrack, t: number, duration = 0.6): AttackSample | null {
  const shots = entity.attacks;
  if (!shots?.length || !Number.isFinite(t) || !(duration > 0)) return null;
  let lo = 0, hi = shots.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (shots[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  if (!lo) return null;
  const shot = shots[lo - 1], age = t - shot;
  if (age < 0 || age >= duration) return null;
  const aim = entity.aim ?? [];
  lo = 0; hi = Math.floor(aim.length / 3);
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (aim[mid * 3] < shot) lo = mid + 1;
    else hi = mid;
  }
  const i = lo * 3;
  return { t: shot, age, x: aim[i] === shot ? aim[i + 1] : null, y: aim[i] === shot ? aim[i + 2] : null };
}

/** Attack clips run once from the observed shot, without an idle phase seed. */
export function attackFrame(age: number, fps: number, frames: number): number {
  return Math.min(Math.max(0, frames - 1), Math.max(0, Math.floor(age * fps)));
}

export function attackFacing(attack: AttackSample | null, x: number, y: number, fallback: number): number {
  if (attack?.x === null || attack?.x === undefined || attack.y === null) return fallback;
  const dx = attack.x - x, dy = attack.y - y;
  if (Math.hypot(dx, dy) < 0.000001) return fallback;
  // Target distance is not velocity; close melee targets still establish
  // an exact heading and must not enter the movement noise dead zone.
  return Math.round(Math.atan2(dx, -dy) / (Math.PI / 4) + 8) % 8;
}

const headings = new WeakMap<readonly number[], { facing: Uint8Array; movedAt: Float64Array }>();

/** Reconstruct facing from past samples instead of retaining canvas state
 * across seeks. Stationary units remember their latest observed attack. */
export function unitFacingAt(
  entity: WeaponTrack & { wp: readonly number[] }, t: number,
  pos: { x: number; y: number; vx: number; vy: number }, active: AttackSample | null,
): number {
  const wp = entity.wp, n = Math.floor(wp.length / 3);
  let cached = headings.get(wp);
  if (!cached) {
    const facing = new Uint8Array(n), movedAt = new Float64Array(n);
    movedAt.fill(-Infinity);
    for (let i = 1; i < n; i += 1) {
      const dx = wp[i * 3 + 1] - wp[(i - 1) * 3 + 1], dy = wp[i * 3 + 2] - wp[(i - 1) * 3 + 2];
      const dt = wp[i * 3] - wp[(i - 1) * 3];
      facing[i] = dt > 0 ? facingFromVelocity(dx / dt, dy / dt, facing[i - 1]) : facing[i - 1];
      movedAt[i] = Math.hypot(dx, dy) > 0.000001 ? wp[i * 3] : movedAt[i - 1];
    }
    cached = { facing, movedAt }; headings.set(wp, cached);
  }
  let lo = 0, hi = n;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (wp[mid * 3] <= t) lo = mid + 1; else hi = mid; }
  const i = Math.max(0, lo - 1);
  let facing = facingFromVelocity(pos.vx, pos.vy, cached.facing[i] ?? 0);
  if (pos.vx === 0 && pos.vy === 0) {
    const lastAttack = attackAt(entity, t, Infinity);
    if (lastAttack && lastAttack.t >= (cached.movedAt[i] ?? -Infinity)) {
      facing = attackFacing(lastAttack, pos.x, pos.y, facing);
    }
  }
  return attackFacing(active, pos.x, pos.y, facing);
}

const MELEE = /^(Zealot|Zergling|Ultralisk|DarkTemplar|Baneling|Drone|Probe|SCV)/;
const BEAM = /^(VoidRay|Colossus|Sentry|Archon|Oracle|Mothership)/;
const ACID = /^(Roach|Ravager|Hydralisk|Mutalisk|Corruptor|Queen|SporeCrawler)/;

/** Brief weapon cues supplement the model's attack pose. Endpoints are
 * observed targets; when an enemy isn't visible, only the attacker flashes.
 * These are visual cues, not a simulation of projectile trajectories. */
export function drawWeaponEffects(
  ctx: CanvasRenderingContext2D, playback: MapPlayback, t: number,
  proj: { k: number; ox: number; oy: number }, view: { z: number },
): number {
  let drawn = 0;
  ctx.save();
  ctx.lineCap = "round";
  ctx.setLineDash([]);
  for (const building of [false, true]) {
    const entities = building ? playback.buildings : playback.units;
    for (let index = 0; index < entities.length; index += 1) {
      const entity = entities[index];
      if (!entity.attacks?.length) continue;
      if (building ? !buildingAliveAt(playback.buildings[index], t) : !unitVisibleAt(playback.units[index], t)) continue;
      const attack = attackAt(entity, t, 0.35);
      if (!attack) continue;
      const pos = building ? buildingPositionAt(playback.buildings[index], attack.t)
        : unitPositionAt(playback.units[index].wp, attack.t);
      if (!pos) continue;
      const name = unitNameAt(entity, attack.t);
      const sx = projectX(playback.bounds, proj, pos.x), sy = projectY(playback.bounds, proj, pos.y);
      const tx = attack.x === null ? sx : projectX(playback.bounds, proj, attack.x);
      const ty = attack.y === null ? sy : projectY(playback.bounds, proj, attack.y);
      const fade = Math.max(0, 1 - attack.age / 0.35);
      const color = MELEE.test(name) ? "#fff1bf" : ACID.test(name) ? "#b2ea64"
        : BEAM.test(name) ? "#9de8ff" : "#ffdda1";
      ctx.globalAlpha = fade * 0.85;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = (BEAM.test(name) ? 2.4 : 1.3) / view.z;
      if (MELEE.test(name)) {
        const r = Math.max(2 / view.z, proj.k * 0.7);
        ctx.beginPath();
        ctx.arc(tx, ty, r, -Math.PI * 0.8 + attack.age * 6, Math.PI * 0.1 + attack.age * 6);
        ctx.stroke();
      } else {
        if (attack.x !== null && attack.y !== null) {
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(1.5 / view.z, proj.k * 0.28) * (0.6 + fade), 0, Math.PI * 2);
        ctx.fill();
      }
      drawn += 1;
    }
  }
  ctx.restore();
  return drawn;
}
