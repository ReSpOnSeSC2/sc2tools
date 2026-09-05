/**
 * Deterministic replay motion and sprite animation. Positions are sampled
 * only from recorded observations. Long gaps hold the last observation.
 * The legacy mining helper remains for isolated presentation demos; the
 * replay viewer does not use it to move workers.
 */

export interface MotionSample {
  x: number;
  y: number;
  /** World units per second. Zero while holding a waypoint. */
  vx: number;
  vy: number;
}

export function motionSample(): MotionSample {
  return { x: 0, y: 0, vx: 0, vy: 0 };
}

/* ──────────────── waypoint tweening ──────────────── */

/** Sparse tracker samples cannot establish the route through an unobserved
 * interval. Only tween nearby observations; never fabricate a late dash,
 * curve around a waypoint, or animate a teleport across the terrain. */
export const MAX_INTERPOLATION_GAP_SEC = 2;
export function sampleTrack(
  wp: readonly number[],
  t: number,
  maxSpeed: number | undefined,
  out: MotionSample,
): MotionSample | null {
  const n = Math.floor(wp.length / 3);
  if (n < 1 || !Number.isFinite(t)) return null;
  out.vx = 0;
  out.vy = 0;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (wp[mid * 3] <= t) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(0, lo - 1) * 3;
  out.x = wp[i + 1];
  out.y = wp[i + 2];
  if (lo === 0 || lo === n) return out;
  const next = i + 3;
  const dt = wp[next] - wp[i];
  const dx = wp[next + 1] - out.x;
  const dy = wp[next + 2] - out.y;
  // Tracker positions use integer map cells; allow two cells of
  // quantization without turning a recall/blink into a walk animation.
  const limit = maxSpeed && maxSpeed > 0 ? maxSpeed : 14;
  if (!(dt > 0) || dt > MAX_INTERPOLATION_GAP_SEC ||
      Math.hypot(dx, dy) > limit * dt + 2) return out;
  const f = (t - wp[i]) / dt;
  out.x += dx * f;
  out.y += dy * f;
  out.vx = dx / dt;
  out.vy = dy / dt;
  return out;
}

/* ──────────────── facing ──────────────── */

/** Sprite sheets ship 8 facings, 45° apart. */
export const FACING_COUNT = 8;

/**
 * Hysteresis half-width, in degrees measured from the CURRENT facing's
 * centre.
 *
 * A bucket is 45° wide, so its boundary sits 22.5° from the centre and
 * 30° keeps the current facing until the heading is 7.5° PAST that
 * boundary. Because the neighbouring bucket is equally sticky, the
 * dead band around a boundary spans ``2·H − 45 = 15°`` — a heading
 * jittering by up to ±7.5° across a boundary never flips. Without it a
 * unit sitting on a boundary re-picks its facing every frame and
 * strobes.
 *
 * Must stay below 67.5°, or a slow turn would hold past the NEXT
 * bucket and skip a facing when it finally switches.
 */
export const FACING_HYSTERESIS_DEG = 30;

/** Below this world-units/second the heading is noise — hold facing. */
export const FACING_MIN_SPEED = 0.35;

/**
 * World velocity → sprite facing row, honouring the sheet contract:
 * "index 0 = unit faces South (down-screen, toward the viewer); index
 * increases counter-clockwise on screen in 45 deg steps".
 *
 * World Y grows UP and canvas Y grows DOWN, so screen velocity is
 * ``(vx, -vy)``. ``atan2(screenX, screenY)`` is exactly the sheet's
 * angle: 0° for (0,+1) = straight down-screen = South = index 0, and
 * +90° for (+1,0) = right = East = index 2 — i.e. counter-clockwise on
 * screen, 45° per index.
 *
 * ``prev`` is the unit's last facing; it is returned unchanged while
 * the unit is effectively stationary and inside the hysteresis band.
 */
export function facingFromVelocity(vx: number, vy: number, prev: number): number {
  const speed = Math.hypot(vx, vy);
  if (speed < FACING_MIN_SPEED) return prev;
  const deg = (Math.atan2(vx, -vy) * 180) / Math.PI;
  const heading = ((deg % 360) + 360) % 360;
  const step = 360 / FACING_COUNT;
  if (prev >= 0 && prev < FACING_COUNT) {
    // Signed shortest angle from the current bucket's centre.
    const delta = (((heading - prev * step) % 360) + 540) % 360 - 180;
    if (Math.abs(delta) <= FACING_HYSTERESIS_DEG) return prev;
  }
  return Math.round(heading / step) % FACING_COUNT;
}

/* ──────────────── animation phase ──────────────── */

/**
 * Effective frame-rate ceiling. Frames advance with GAME time, so a
 * 12 fps walk cycle runs at 192 fps under 16× playback — past a
 * display's refresh that is not "faster", it is noise. Saturating at
 * 60 keeps 1× exact, keeps 4× exact for every cycle up to 15 fps, and
 * turns 8×/16× into a blur rather than a strobe.
 */
export const ANIM_FPS_CEILING = 60;

/**
 * Deterministic per-unit phase in [0,1) from the unit's payload index.
 * Stable for the whole game (and across scrubs), so a pack of
 * Zerglings does not march in lockstep, and nothing reshuffles when a
 * neighbour dies.
 */
export function phaseOffset(seed: number): number {
  let h = Math.imul(seed | 0, 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return ((h >>> 0) % 4096) / 4096;
}

/** Frame index for an anim at game-second ``t``, offset by the unit's
 * own phase. Stateless — scrubbing lands on the same frame every time. */
export function animFrameIndex(
  t: number,
  fps: number,
  frames: number,
  phase01: number,
): number {
  if (frames <= 1) return 0;
  const rate = Math.min(Math.max(0, fps), ANIM_FPS_CEILING);
  if (rate <= 0) return Math.floor(phase01 * frames) % frames;
  const f = Math.floor(t * rate + phase01 * frames);
  return ((f % frames) + frames) % frames;
}

/* ──────────────── worker mining cycle ──────────────── */

/**
 * Length of one hall → patch → hall round trip, in game seconds.
 * A real close-patch cycle is ~3 s of travel plus mining; 5.2 s reads
 * as busy without becoming a blur at 8×/16× playback.
 */
export const MINING_CYCLE_SEC = 5.2;
/** Where the worker docks on the hall: its footprint edge, on the
 * patch's side, so a base's workers fan around the hall instead of
 * stacking in its centre. World units from the hall centre. */
export const HALL_DOCK_RADIUS = 2.4;

/** Cycle phase boundaries (fractions of ``MINING_CYCLE_SEC``):
 * haul to the hall, dwell at the hall, return to the patch, mine. */
const PHASE_HAUL_END = 0.34;
const PHASE_DOCK_END = 0.44;
const PHASE_RETURN_END = 0.78;

/**
 * Where a mining worker is at game-second ``t``, and how fast.
 *
 * ``hall`` is the town hall's CURRENT centre and ``stand`` the spot in
 * front of its assigned patch (``patchMiningPosition``) or on the v1
 * arc fallback (``miningArcPosition``) — the same anchor points the
 * static presentation used; only the interpolation between them is
 * new. ``seed`` staggers each worker's phase so a mineral line has
 * workers at every stage of the trip at once.
 */
export function miningCycleSample(
  hall: { x: number; y: number },
  stand: { x: number; y: number },
  t: number,
  seed: number,
  out: MotionSample,
): MotionSample {
  const dx = stand.x - hall.x;
  const dy = stand.y - hall.y;
  const dist = Math.hypot(dx, dy);
  // Dock on the hall's edge facing the patch; degenerate distances
  // (a patch on top of the hall) collapse to the hall centre.
  const f = dist > HALL_DOCK_RADIUS ? HALL_DOCK_RADIUS / dist : 0;
  const dockX = hall.x + dx * f;
  const dockY = hall.y + dy * f;

  const phase = (t / MINING_CYCLE_SEC + phaseOffset(seed)) % 1;
  const legX = stand.x - dockX;
  const legY = stand.y - dockY;

  if (phase < PHASE_HAUL_END) {
    const u = phase / PHASE_HAUL_END;
    const secs = PHASE_HAUL_END * MINING_CYCLE_SEC;
    out.x = stand.x - legX * u;
    out.y = stand.y - legY * u;
    out.vx = -legX / secs;
    out.vy = -legY / secs;
  } else if (phase < PHASE_DOCK_END) {
    out.x = dockX;
    out.y = dockY;
    out.vx = 0;
    out.vy = 0;
  } else if (phase < PHASE_RETURN_END) {
    const u = (phase - PHASE_DOCK_END) / (PHASE_RETURN_END - PHASE_DOCK_END);
    const secs = (PHASE_RETURN_END - PHASE_DOCK_END) * MINING_CYCLE_SEC;
    out.x = dockX + legX * u;
    out.y = dockY + legY * u;
    out.vx = legX / secs;
    out.vy = legY / secs;
  } else {
    out.x = stand.x;
    out.y = stand.y;
    out.vx = 0;
    out.vy = 0;
  }
  return out;
}
