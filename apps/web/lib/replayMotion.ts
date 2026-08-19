/**
 * replayMotion — pure motion maths for the sprite map replayer.
 *
 * The playback payload stores SPARSE waypoints: the upload pipeline
 * enforces a 2.0 s minimum gap and caps a unit at 240 waypoints. Drawn
 * naively that reads as teleporting; drawn with plain lerp it reads as
 * robots turning square corners. Everything here turns those sparse
 * anchors into a continuous position + velocity signal that the sprite
 * layer can drive facing and animation from:
 *
 *   sampleTrack()        position AND velocity, speed-capped hold plus
 *                        clamped Catmull-Rom through the neighbours
 *   facingFromVelocity() world velocity → one of the sheet's 8 facings,
 *                        with hysteresis so units don't strobe
 *   animFrameIndex()     game-time driven frame, so animation speed
 *                        tracks the 1x/4x/8x/16x playback speed
 *   miningCycleSample()  the hall → patch → hall worker loop
 *
 * Pure and deterministic: same inputs → same output, no RNG, no state.
 * Every function writes into a caller-owned ``out`` object so a
 * 500-unit frame allocates nothing.
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

/**
 * How far a Catmull-Rom tangent may reach, as a multiple of the
 * segment's own chord.
 *
 * Catmull-Rom through far-apart neighbours overshoots wildly. Clamping
 * each endpoint tangent to ``TANGENT_CLAMP × |chord|`` bounds how far
 * the curve can leave the straight chord. In the Hermite basis the
 * deviation from the chord is exactly
 *
 *     smooth · [ −u(2u−1)(u−1)·chord + h10·mB + h11·mC ]
 *
 * whose three terms peak at 0.0962, 0.1481 and 0.1481 of their
 * coefficients, so
 *
 *     |deviation| ≤ (0.0962 + 0.2963 · TANGENT_CLAMP) · |chord|
 *
 * — 0.348 × chord at 0.85. Enough curvature to round a corner, far too
 * little to swing a unit off the map. (Harness measures 0.263.)
 */
export const TANGENT_CLAMP = 0.85;

/**
 * Interpolated world position AND velocity at game-second ``t``.
 *
 * Three behaviours compose, in this order:
 *
 * 1. **Speed-capped departure** (inherited from ``unitPositionAt``): a
 *    unit HOLDS its last known anchor — mining, building, sieged — and
 *    departs at the last moment that still arrives on time at
 *    ``maxSpeed``. Without this a worker parked at one base and seen
 *    again at another minutes later drifts across the map for the
 *    whole gap ("floating probes").
 * 2. **Clamped Catmull-Rom** over the part of the segment it is
 *    actually moving, with tangents taken from the NEIGHBOURING
 *    waypoints in real time units (non-uniform / Overhauser form, so
 *    unequal gaps don't produce speed jumps), each clamped to
 *    ``TANGENT_CLAMP × chord``.
 * 3. **Smoothing weight**: the more of a segment is spent holding, the
 *    less curve is applied — a unit that waits then dashes moved with
 *    purpose and should travel straight. ``smooth = effective/span``,
 *    so a continuously-moving unit gets the full curve and a
 *    hold-then-dash gets a straight line.
 *
 * Clamps before the first and after the last waypoint (velocity 0).
 * Returns null only for an empty track.
 *
 * Speed guarantee: positions still ARRIVE ON TIME, but the Hermite
 * eases in and out rather than running at a constant rate, so the
 * momentary speed can exceed the segment average. Evaluating
 * ``|d01| + |d10| + |d11|`` over u ∈ [0,1] caps that at exactly 2× the
 * segment average (worst case at u = 0.5, where the basis derivatives
 * are 1.5, −0.25, −0.25); a realistic speed-capped dash measures
 * ~1.11×. That is presentation, not simulation — the ease reads as
 * acceleration out of a stop.
 */
export function sampleTrack(
  wp: readonly number[],
  t: number,
  maxSpeed: number | undefined,
  out: MotionSample,
): MotionSample | null {
  const n = (wp.length / 3) | 0;
  if (n < 1) return null;
  out.vx = 0;
  out.vy = 0;
  if (n === 1 || t <= wp[0]) {
    out.x = wp[1];
    out.y = wp[2];
    return out;
  }
  const lastBase = (n - 1) * 3;
  if (t >= wp[lastBase]) {
    out.x = wp[lastBase + 1];
    out.y = wp[lastBase + 2];
    return out;
  }
  // Binary search beats the old linear scan: 240 waypoints × 500 units
  // × 60 fps is 7.2 M comparisons/second, and scrubbing breaks any
  // forward-cursor trick anyway. log2(240) ≈ 8 steps instead.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (wp[mid * 3] <= t) lo = mid;
    else hi = mid;
  }
  const bB = lo * 3;
  const bC = bB + 3;
  const tB = wp[bB];
  const xB = wp[bB + 1];
  const yB = wp[bB + 2];
  const tC = wp[bC];
  const xC = wp[bC + 1];
  const yC = wp[bC + 2];
  const span = tC - tB;
  if (!(span > 0)) {
    out.x = xC;
    out.y = yC;
    return out;
  }

  const chordX = xC - xB;
  const chordY = yC - yB;
  const chord = Math.hypot(chordX, chordY);

  let depart = tB;
  if (maxSpeed !== undefined && Number.isFinite(maxSpeed) && maxSpeed > 0) {
    depart = Math.max(tB, tC - chord / maxSpeed);
  }
  const eff = tC - depart;
  if (eff <= 0 || t <= depart) {
    // Still holding the anchor: parked, mining, building, sieged.
    out.x = xB;
    out.y = yB;
    return out;
  }
  const u = (t - depart) / eff;

  // Endpoint velocities from the neighbours, in world units/second.
  // One-sided (the chord's own velocity) at the ends of the track.
  let vBx: number;
  let vBy: number;
  let vCx: number;
  let vCy: number;
  if (lo > 0) {
    const bA = bB - 3;
    const dt = tC - wp[bA];
    const inv = dt > 0 ? 1 / dt : 0;
    vBx = (xC - wp[bA + 1]) * inv;
    vBy = (yC - wp[bA + 2]) * inv;
  } else {
    vBx = chordX / span;
    vBy = chordY / span;
  }
  if (lo + 2 < n) {
    const bD = bC + 3;
    const dt = wp[bD] - tB;
    const inv = dt > 0 ? 1 / dt : 0;
    vCx = (wp[bD + 1] - xB) * inv;
    vCy = (wp[bD + 2] - yB) * inv;
  } else {
    vCx = chordX / span;
    vCy = chordY / span;
  }

  // Neighbour velocities → Hermite tangents over u ∈ [0,1]: the chain
  // rule gives dP/du = v · eff. Clamp each against the chord, then
  // blend toward the chord itself by the smoothing weight, so that:
  //
  //   smooth = 1 (moving the whole segment) → full non-uniform
  //     Catmull-Rom, rounding the corner through the neighbours;
  //   smooth = 0 (a long hold then a short dash) → mB = mC = chord,
  //     which is EXACTLY the straight constant-speed line the old
  //     lerp drew. A unit that waited and then moved moved on purpose.
  //
  // Blending after the clamp keeps the smooth=0 case exactly straight
  // (clamping it would reintroduce a slight ease), and the deviation
  // bound simply scales by ``smooth``.
  const smooth = eff / span;
  const limit = TANGENT_CLAMP * chord;
  let mBx = vBx * eff;
  let mBy = vBy * eff;
  let mCx = vCx * eff;
  let mCy = vCy * eff;
  const mB = Math.hypot(mBx, mBy);
  if (mB > limit && mB > 0) {
    const f = limit / mB;
    mBx *= f;
    mBy *= f;
  }
  const mC = Math.hypot(mCx, mCy);
  if (mC > limit && mC > 0) {
    const f = limit / mC;
    mCx *= f;
    mCy *= f;
  }
  if (smooth < 1) {
    const rest = 1 - smooth;
    mBx = mBx * smooth + chordX * rest;
    mBy = mBy * smooth + chordY * rest;
    mCx = mCx * smooth + chordX * rest;
    mCy = mCy * smooth + chordY * rest;
  }

  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  out.x = h00 * xB + h10 * mBx + h01 * xC + h11 * mCx;
  out.y = h00 * yB + h10 * mBy + h01 * yC + h11 * mCy;

  const d00 = 6 * u2 - 6 * u;
  const d10 = 3 * u2 - 4 * u + 1;
  const d01 = -6 * u2 + 6 * u;
  const d11 = 3 * u2 - 2 * u;
  const invEff = 1 / eff;
  out.vx = (d00 * xB + d10 * mBx + d01 * xC + d11 * mCx) * invEff;
  out.vy = (d00 * yB + d10 * mBy + d01 * yC + d11 * mCy) * invEff;
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
