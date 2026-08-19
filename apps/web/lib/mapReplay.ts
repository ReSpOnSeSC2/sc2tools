/**
 * mapReplay — pure data layer for the vespene.gg-style map replayer.
 *
 * The agent uploads a compact playback payload per game (see the
 * pipeline's ``_compact_map_playback``): per-unit waypoint tracks as
 * flat ``[t, x, y, …]`` arrays in SC2 world coordinates, building
 * placements, battle markers, spawn anchors, per-side stats series
 * and the map's playable bounds. Everything here is deterministic
 * math — interpolation, world→canvas projection, and the cluster
 * spreading that keeps stacked units readable — so the canvas
 * component stays a thin draw loop and the hard parts unit-test.
 */

export interface PlaybackBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PlaybackSpawn {
  owner: "me" | "opp";
  x: number;
  y: number;
}

export interface PlaybackBattle {
  t: number;
  x: number;
  y: number;
}

export interface PlaybackBuilding {
  owner: "me" | "opp";
  name: string;
  t: number;
  x: number;
  y: number;
  /** Lift-off landing points, flat [t, x, y, …] (v3 payloads). */
  moves: number[];
  /** Game-second the structure died, or null if it survived. */
  died: number | null;
}

export interface PlaybackUnit {
  owner: "me" | "opp";
  name: string;
  born: number;
  died: number | null;
  /** Spent death (v4): the death event had no killer — a Drone
   * morphing into a structure, Templar merging into an Archon, a
   * MULE expiring. Absent on older payloads and on killed units. */
  sd?: boolean;
  /** Flat [t, x, y, t, x, y, …], ascending t. */
  wp: number[];
}

export type ResourceKind = "minerals" | "gold" | "gas" | "rocks" | "tower";

export interface PlaybackResource {
  kind: ResourceKind;
  x: number;
  y: number;
  /** Game-second the node left play (patch mined out, rocks broken),
   * or null if it lasted the whole game. */
  died: number | null;
}

/** One ability / spell cast (v5 payloads). Compact on the wire:
 *  ``o`` 0 = me / 1 = opponent, ``a`` a stable ability slug
 *  ("PsiStorm", "EMP", "FungalGrowth", …) that the engine maps raw
 *  sc2reader ability names onto, ``t`` game seconds. ``x`` / ``y`` are
 *  ABSENT (not null) for a self-cast the engine could not place —
 *  Stim, Burrow — and the replayer pins those to the casting unit. */
export interface ReplayCast {
  o: 0 | 1;
  a: string;
  t: number;
  x?: number;
  y?: number;
}

export interface MapPlayback {
  v: number;
  mapName: string;
  gameLength: number;
  bounds: PlaybackBounds;
  spawns: PlaybackSpawn[];
  battles: PlaybackBattle[];
  buildings: PlaybackBuilding[];
  units: PlaybackUnit[];
  /** Neutral terrain furniture (v2 payloads; empty for v1). */
  resources: PlaybackResource[];
  /** Ability / spell casts (v5 payloads). OPTIONAL — v4 and older
   *  payloads have no casts at all and must keep rendering exactly as
   *  before, so this is undefined rather than an empty array there. */
  casts?: ReplayCast[];
  /** Per-side [t, armyValue, workers, supplyUsed] rows, ascending t. */
  stats: { me: number[][]; opp: number[][] };
}

/** Strict re-sanitize of the wire payload — the canvas must render
 *  safely even if a hostile blob reaches the endpoint. */
export function sanitizeMapPlayback(raw: unknown): MapPlayback | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const b = p.bounds as Record<string, unknown> | undefined;
  const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : NaN);
  if (!b) return null;
  const bounds: PlaybackBounds = {
    minX: num(b.minX),
    minY: num(b.minY),
    maxX: num(b.maxX),
    maxY: num(b.maxY),
  };
  if (
    !Number.isFinite(bounds.minX) ||
    !Number.isFinite(bounds.minY) ||
    bounds.maxX <= bounds.minX ||
    bounds.maxY <= bounds.minY
  ) {
    return null;
  }
  const owner = (v: unknown): "me" | "opp" | null =>
    v === "me" || v === "opp" ? v : null;
  const units: PlaybackUnit[] = [];
  for (const u of Array.isArray(p.units) ? p.units.slice(0, 1200) : []) {
    if (!u || typeof u !== "object") continue;
    const r = u as Record<string, unknown>;
    const o = owner(r.owner);
    const wpRaw = Array.isArray(r.wp) ? r.wp.slice(0, 3 * 400) : [];
    const wp: number[] = [];
    for (let i = 0; i + 2 < wpRaw.length; i += 3) {
      const t = num(wpRaw[i]);
      const x = num(wpRaw[i + 1]);
      const y = num(wpRaw[i + 2]);
      if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) break;
      wp.push(t, x, y);
    }
    if (!o || wp.length === 0) continue;
    // ``num`` alone is a trap for born/died: the wire encodes "still
    // alive" as ``died: null`` and ``Number(null)`` is 0, which would
    // mark every surviving unit dead at t=0 and hide it for the whole
    // playback. Treat null/undefined as absent BEFORE coercing.
    const born = r.born === null || r.born === undefined ? NaN : num(r.born);
    const died = r.died === null || r.died === undefined ? NaN : num(r.died);
    units.push({
      owner: o,
      name: typeof r.name === "string" ? r.name.slice(0, 40) : "",
      born: Number.isFinite(born) ? born : wp[0],
      died: Number.isFinite(died) ? died : null,
      ...(r.sd === true ? { sd: true } : {}),
      wp,
    });
  }
  const buildings: PlaybackBuilding[] = [];
  for (const bd of Array.isArray(p.buildings) ? p.buildings.slice(0, 1000) : []) {
    if (!bd || typeof bd !== "object") continue;
    const r = bd as Record<string, unknown>;
    const o = owner(r.owner);
    const x = num(r.x);
    const y = num(r.y);
    if (!o || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const movesRaw = Array.isArray(r.moves) ? r.moves.slice(0, 60) : [];
    const moves: number[] = [];
    for (let i = 0; i + 2 < movesRaw.length; i += 3) {
      const mt = num(movesRaw[i]);
      const mx = num(movesRaw[i + 1]);
      const my = num(movesRaw[i + 2]);
      if (!Number.isFinite(mt) || !Number.isFinite(mx) || !Number.isFinite(my)) break;
      moves.push(mt, mx, my);
    }
    const bDied = r.died === null || r.died === undefined ? NaN : num(r.died);
    buildings.push({
      owner: o,
      name: typeof r.name === "string" ? r.name.slice(0, 40) : "",
      t: Number.isFinite(num(r.t)) ? num(r.t) : 0,
      x,
      y,
      moves,
      died: Number.isFinite(bDied) ? bDied : null,
    });
  }
  const spawns: PlaybackSpawn[] = [];
  for (const s of Array.isArray(p.spawns) ? p.spawns.slice(0, 8) : []) {
    if (!s || typeof s !== "object") continue;
    const r = s as Record<string, unknown>;
    const o = owner(r.owner);
    const x = num(r.x);
    const y = num(r.y);
    if (o && Number.isFinite(x) && Number.isFinite(y)) spawns.push({ owner: o, x, y });
  }
  const battles: PlaybackBattle[] = [];
  for (const m of Array.isArray(p.battles) ? p.battles.slice(0, 200) : []) {
    if (!m || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    const t = num(r.t);
    const x = num(r.x);
    const y = num(r.y);
    if (Number.isFinite(t) && Number.isFinite(x) && Number.isFinite(y)) {
      battles.push({ t, x, y });
    }
  }
  const resources: PlaybackResource[] = [];
  const kinds: ReadonlySet<string> = new Set([
    "minerals", "gold", "gas", "rocks", "tower",
  ]);
  for (const rn of Array.isArray(p.resources) ? p.resources.slice(0, 600) : []) {
    if (!rn || typeof rn !== "object") continue;
    const r = rn as Record<string, unknown>;
    const x = num(r.x);
    const y = num(r.y);
    if (typeof r.kind !== "string" || !kinds.has(r.kind)) continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const died = r.died === null || r.died === undefined ? NaN : num(r.died);
    resources.push({
      kind: r.kind as ResourceKind,
      x,
      y,
      died: Number.isFinite(died) ? died : null,
    });
  }
  const statsIn = (p.stats ?? {}) as Record<string, unknown>;
  const side = (v: unknown): number[][] =>
    (Array.isArray(v) ? v.slice(0, 800) : [])
      .filter((row): row is number[] => Array.isArray(row) && row.length >= 2)
      .map((row) => row.map((c) => num(c)))
      .filter((row) => row.every((c) => Number.isFinite(c)));
  const statsMe = side(statsIn.me);
  const statsOpp = side(statsIn.opp);
  const lastActivity = Math.max(
    0,
    ...units.map((u) => u.died ?? u.wp[u.wp.length - 3]),
    ...battles.map((m) => m.t),
    ...(statsMe.length ? [statsMe[statsMe.length - 1][0]] : []),
    ...(statsOpp.length ? [statsOpp[statsOpp.length - 1][0]] : []),
  );
  let gameLength = Math.max(
    Number.isFinite(num(p.gameLength)) ? num(p.gameLength) : 0,
    lastActivity,
    1,
  );
  // v<=2 payloads carried a Blizzard game-time length (1.4x real on
  // Faster) while every event used real seconds — the scrubber ran
  // ~40% past the game. When the declared length overshoots all
  // recorded activity by >20%, trust the events: stats land every
  // ~10s until the end, so their last row is a tight bound.
  if (lastActivity > 60 && gameLength > lastActivity * 1.2) {
    gameLength = Math.round(lastActivity * 1.02);
  }
  // Casts (v5). Same defensive treatment as everything else: drop
  // malformed entries one by one, cap the length, clamp t into the
  // playback's own timeline. Absent/!Array input yields an empty list
  // and the key is then omitted from the result entirely, so a v4
  // payload behaves exactly as it did before v5 existed.
  const casts: ReplayCast[] = [];
  for (const cs of Array.isArray(p.casts) ? p.casts.slice(0, 800) : []) {
    if (!cs || typeof cs !== "object") continue;
    const r = cs as Record<string, unknown>;
    if (typeof r.a !== "string" || r.a.length === 0) continue;
    const t = num(r.t);
    if (!Number.isFinite(t)) continue;
    const o = num(r.o) === 1 ? 1 : 0;
    const cast: ReplayCast = {
      o,
      a: r.a.slice(0, 40),
      t: Math.min(Math.max(t, 0), gameLength),
    };
    // x/y travel as a pair or not at all — half a coordinate is a
    // malformed cast, not a cast at the origin.
    const x = r.x === null || r.x === undefined ? NaN : num(r.x);
    const y = r.y === null || r.y === undefined ? NaN : num(r.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      cast.x = x;
      cast.y = y;
    }
    casts.push(cast);
  }
  if (units.length === 0 && buildings.length === 0) return null;
  return {
    v: Number.isFinite(num(p.v)) ? num(p.v) : 1,
    mapName: typeof p.mapName === "string" ? p.mapName.slice(0, 120) : "",
    gameLength,
    bounds,
    spawns,
    battles,
    buildings,
    units,
    resources,
    ...(casts.length ? { casts } : {}),
    stats: { me: statsMe, opp: statsOpp },
  };
}

/** Is the unit alive (born ≤ t, not yet died) at time t? */
export function unitAliveAt(unit: PlaybackUnit, t: number): boolean {
  if (unit.born > t) return false;
  return unit.died === null || unit.died > t;
}

/**
 * Interpolated world position at time t from a flat waypoint array.
 * Clamps before the first and after the last waypoint (a unit sitting
 * still simply has no further waypoints).
 *
 * ``maxSpeed`` (world cells/sec) switches long gaps from a slow
 * constant drift to an arrive-on-time model: waypoints are sparse
 * anchors (a worker's known spot at a mineral line, then its known
 * spot at the next base minutes later), and naive lerp drags the unit
 * across the map for the whole gap — the "floating probes" artifact.
 * With a speed cap the unit HOLDS its last anchor (mining, building)
 * and departs at the latest moment that still arrives on time at the
 * unit's real movement speed. Gaps tighter than the cap degrade to
 * plain lerp, so understating a fast unit's speed is harmless.
 */
export function unitPositionAt(
  wp: readonly number[],
  t: number,
  maxSpeed?: number,
): { x: number; y: number } | null {
  if (wp.length < 3) return null;
  if (t <= wp[0]) return { x: wp[1], y: wp[2] };
  const last = wp.length - 3;
  if (t >= wp[last]) return { x: wp[last + 1], y: wp[last + 2] };
  // Linear scan is fine: compaction caps waypoints per unit at ~240.
  for (let i = 0; i + 5 < wp.length; i += 3) {
    const t0 = wp[i];
    const t1 = wp[i + 3];
    if (t < t0 || t > t1 || t1 <= t0) continue;
    const x0 = wp[i + 1];
    const y0 = wp[i + 2];
    const x1 = wp[i + 4];
    const y1 = wp[i + 5];
    let depart = t0;
    if (maxSpeed !== undefined && Number.isFinite(maxSpeed) && maxSpeed > 0) {
      const travel = Math.hypot(x1 - x0, y1 - y0) / maxSpeed;
      depart = Math.max(t0, t1 - travel);
    }
    if (t <= depart) return { x: x0, y: y0 };
    const f = (t - depart) / (t1 - depart);
    return { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f };
  }
  return { x: wp[last + 1], y: wp[last + 2] };
}

/**
 * Per-unit movement-speed cap for the arrive-on-time interpolation,
 * in world cells/sec. Workers use their real base speed; everything
 * else gets a conservative army default — a genuinely faster unit
 * (speedlings, mutas) just clamps back to plain lerp inside tight
 * gaps, which is the old behaviour.
 */
export function unitMaxSpeed(name: string): number {
  return isWorkerUnit(name) ? 3.94 : 5.5;
}

/* ──────────────── mining-line presentation ────────────────
 *
 * Workers auto-mine when given no orders, so a worker parked near a
 * town hall should be SHOWN on the mineral line, the way vespene.gg
 * presents its worker lines. The playback payload carries no mineral
 * patch coordinates, but ladder mineral lines consistently back onto
 * the map edge behind the base — so the presentation arc faces away
 * from the map center. Deterministic per unit seed: the same worker
 * holds the same spot on the line frame after frame.
 */

/** How close (world cells) a worker must be to a friendly town hall
 * to be presented as mining at it. Wide enough to catch workers
 * parked past the mineral line (patches sit 5-7 cells out) without
 * grabbing genuine mid-map travellers. */
export const MINING_SNAP_RADIUS = 12;

/** Nearest hall within ``maxDist`` of ``pos``, or null. */
export function nearestTownHall(
  pos: { x: number; y: number },
  halls: ReadonlyArray<{ x: number; y: number }>,
  maxDist: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = maxDist;
  for (const hall of halls) {
    const d = Math.hypot(hall.x - pos.x, hall.y - pos.y);
    if (d <= bestD) {
      best = hall;
      bestD = d;
    }
  }
  return best;
}

/**
 * A deterministic spot on the hall's mineral-line arc for ``seed``:
 * ±55° around the away-from-center direction, 4–6 cells out (the
 * distance of a real mineral line from the hall's center). Low-
 * discrepancy fractions of the seed spread consecutive workers evenly
 * along the arc without any shared state.
 */
export function miningArcPosition(
  hall: { x: number; y: number },
  bounds: PlaybackBounds,
  seed: number,
): { x: number; y: number } {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const away = Math.atan2(hall.y - cy, hall.x - cx);
  const fracA = (seed * 0.618033988749895) % 1;
  const fracR = (seed * 0.754877666246693) % 1;
  const angle = away + (fracA * 2 - 1) * ((55 * Math.PI) / 180);
  const radius = 4 + fracR * 2;
  return {
    x: hall.x + radius * Math.cos(angle),
    y: hall.y + radius * Math.sin(angle),
  };
}

/** Is the resource node still in play at time t? */
export function resourceAliveAt(node: PlaybackResource, t: number): boolean {
  return node.died === null || node.died > t;
}

/**
 * The hall's live mineral patches (regular + gold) at time t, sorted
 * by distance so slot assignment is stable.
 */
export function patchesNearHall(
  resources: ReadonlyArray<PlaybackResource>,
  hall: { x: number; y: number },
  t: number,
  radius = 11,
): PlaybackResource[] {
  return resources
    .filter(
      (r) =>
        (r.kind === "minerals" || r.kind === "gold") &&
        resourceAliveAt(r, t) &&
        Math.hypot(r.x - hall.x, r.y - hall.y) <= radius,
    )
    .sort(
      (a, b) =>
        Math.hypot(a.x - hall.x, a.y - hall.y) -
        Math.hypot(b.x - hall.x, b.y - hall.y),
    );
}

/**
 * Where a worker mining ``patch`` stands: just in front of the patch
 * on the hall side, with a whisker of per-seed jitter so two workers
 * on one patch don't perfectly overlap.
 */
/** Is the building standing at time t (placed, not yet destroyed)? */
export function buildingAliveAt(b: PlaybackBuilding, t: number): boolean {
  if (b.t > t) return false;
  return b.died === null || b.died > t;
}

/* ──────────────── gas geysers ────────────────
 *
 * A geyser and the structure built on it are recorded at the SAME map
 * coordinate — verified across ten real payloads (138 gas structures,
 * Δx = Δy = 0.00 for every one of them). The tolerance below is
 * therefore only slack for a hand-edited or future payload, not a real
 * expected offset.
 */
export const GAS_TAP_RADIUS = 1.5;

const GAS_STRUCTURES: ReadonlySet<string> = new Set([
  "Refinery",
  "RefineryRich",
  "Extractor",
  "ExtractorRich",
  "Assimilator",
  "AssimilatorRich",
]);

/** Is this a vespene structure (the thing that covers a geyser)? */
export function isGasStructure(name: string): boolean {
  return GAS_STRUCTURES.has(name);
}

/**
 * Is a gas structure standing on this geyser at time t?
 *
 * Shared by the draw pass (which must not paint a geyser that has been
 * built over) and the mining-slot builder (which only gives a hall gas
 * slots once the geyser is tapped), so the two cannot drift.
 * ``owner`` narrows it to one side; omitted, either side counts.
 */
export function gasTappedAt(
  buildings: ReadonlyArray<PlaybackBuilding>,
  node: { x: number; y: number },
  t: number,
  owner?: "me" | "opp",
): boolean {
  for (const b of buildings) {
    if (owner && b.owner !== owner) continue;
    if (!isGasStructure(b.name)) continue;
    if (!buildingAliveAt(b, t)) continue;
    if (Math.hypot(b.x - node.x, b.y - node.y) <= GAS_TAP_RADIUS) return true;
  }
  return false;
}

/** Flying-building cruise speed for relocation interpolation. */
const BUILDING_FLY_SPEED = 1.3;

/**
 * Where the building stands at time t: its construction site until
 * the first lift-off landing, then each landing point in turn. The
 * hop between spots is interpolated at flying-building speed with
 * the same arrive-on-time model units use, so a floated Command
 * Center is SHOWN at its old base, crawls across late, and sits at
 * the expansion it actually landed on.
 */
export function buildingPositionAt(
  b: PlaybackBuilding,
  t: number,
): { x: number; y: number } {
  if (b.moves.length === 0) return { x: b.x, y: b.y };
  const wp = [b.t, b.x, b.y, ...b.moves];
  return unitPositionAt(wp, t, BUILDING_FLY_SPEED) ?? { x: b.x, y: b.y };
}

export function patchMiningPosition(
  patch: { x: number; y: number },
  hall: { x: number; y: number },
  seed: number,
): { x: number; y: number } {
  const dx = hall.x - patch.x;
  const dy = hall.y - patch.y;
  const d = Math.hypot(dx, dy) || 1;
  const stand = 1.1 + ((seed * 0.618033988749895) % 1) * 0.5;
  return {
    x: patch.x + (dx / d) * stand,
    y: patch.y + (dy / d) * stand,
  };
}

/**
 * World → canvas projection preserving aspect ratio, with the SC2
 * Y axis flipped (world Y grows upward, canvas Y grows downward).
 * Returns the scale and offsets so callers project many points
 * cheaply: ``cx = ox + (x - minX) * k`` / ``cy = oy + (maxY - y) * k``.
 */
export function worldProjection(
  bounds: PlaybackBounds,
  canvasW: number,
  canvasH: number,
  pad = 8,
): { k: number; ox: number; oy: number } {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const k = Math.min((canvasW - pad * 2) / w, (canvasH - pad * 2) / h);
  return {
    k,
    ox: (canvasW - w * k) / 2,
    oy: (canvasH - h * k) / 2,
  };
}

export function projectX(
  bounds: PlaybackBounds,
  proj: { k: number; ox: number },
  x: number,
): number {
  return proj.ox + (x - bounds.minX) * proj.k;
}

export function projectY(
  bounds: PlaybackBounds,
  proj: { k: number; oy: number },
  y: number,
): number {
  return proj.oy + (bounds.maxY - y) * proj.k;
}

/**
 * Cluster spreading — the "unit spacing" fix. Many units share (or
 * nearly share) an interpolated position (an army sitting on one
 * waypoint), which naïvely renders as a single dot hiding the army's
 * size. This groups points within ``cellPx`` and lays each group out
 * on a deterministic sunflower (phyllotaxis) pattern around the
 * group's centroid, so a 20-stalker ball reads as a tidy 20-dot blob.
 *
 * ``seeds`` (optional, parallel to ``points``) gives each point a
 * stable identity: spiral slots are assigned in ascending-seed order,
 * so when a unit dies mid-battle every unit with a LOWER seed keeps
 * its exact spot instead of the whole blob reshuffling with the
 * caller's iteration order. Callers pass a per-game-stable id (the
 * unit's index in the playback payload); without seeds, input order
 * seeds the slots as before.
 *
 * Input/output orders match 1:1 (the caller keeps color/name per
 * index). Pure and deterministic: same input → same layout, no RNG.
 */
export function spreadClusters(
  points: ReadonlyArray<{ x: number; y: number }>,
  cellPx: number,
  spacingPx: number,
  seeds?: ReadonlyArray<number>,
): Array<{ x: number; y: number }> {
  const GOLDEN_ANGLE = 2.399963229728653;
  const cells = new Map<string, number[]>();
  points.forEach((point, i) => {
    const key = `${Math.round(point.x / cellPx)}:${Math.round(point.y / cellPx)}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(i);
    else cells.set(key, [i]);
  });
  const out: Array<{ x: number; y: number }> = points.map((point) => ({ ...point }));
  for (const bucket of cells.values()) {
    if (bucket.length < 2) continue;
    let cx = 0;
    let cy = 0;
    for (const i of bucket) {
      cx += points[i].x;
      cy += points[i].y;
    }
    cx /= bucket.length;
    cy /= bucket.length;
    if (seeds) {
      bucket.sort((a, b) => (seeds[a] ?? a) - (seeds[b] ?? b));
    }
    bucket.forEach((pointIndex, j) => {
      // j = 0 sits on the centroid; the rest spiral outward.
      if (j === 0) {
        out[pointIndex] = { x: cx, y: cy };
        return;
      }
      const r = spacingPx * Math.sqrt(j);
      const a = j * GOLDEN_ANGLE;
      out[pointIndex] = {
        x: cx + r * Math.cos(a),
        y: cy + r * Math.sin(a),
      };
    });
  }
  return out;
}

/** Linear interpolation over per-side stats rows ([t, army, workers, supply]). */
export function statsAt(
  rows: readonly number[][],
  t: number,
): { army: number; workers: number; supply: number } {
  if (rows.length === 0) return { army: 0, workers: 0, supply: 0 };
  if (t <= rows[0][0]) {
    return { army: rows[0][1] ?? 0, workers: rows[0][2] ?? 0, supply: rows[0][3] ?? 0 };
  }
  const last = rows[rows.length - 1];
  if (t >= last[0]) {
    return { army: last[1] ?? 0, workers: last[2] ?? 0, supply: last[3] ?? 0 };
  }
  for (let i = 0; i + 1 < rows.length; i += 1) {
    const a = rows[i];
    const b = rows[i + 1];
    if (t < a[0] || t > b[0] || b[0] <= a[0]) continue;
    const f = (t - a[0]) / (b[0] - a[0]);
    return {
      army: (a[1] ?? 0) + ((b[1] ?? 0) - (a[1] ?? 0)) * f,
      workers: (a[2] ?? 0) + ((b[2] ?? 0) - (a[2] ?? 0)) * f,
      supply: (a[3] ?? 0) + ((b[3] ?? 0) - (a[3] ?? 0)) * f,
    };
  }
  return { army: last[1] ?? 0, workers: last[2] ?? 0, supply: last[3] ?? 0 };
}

/** Worker unit names render dimmer/smaller than army. */
export const WORKER_UNIT_NAMES: ReadonlySet<string> = new Set([
  "Probe",
  "SCV",
  "Drone",
  "MULE",
]);

export function isWorkerUnit(name: string): boolean {
  return WORKER_UNIT_NAMES.has(name);
}

/** Town-hall names render as the biggest building squares. */
export const TOWNHALL_NAMES: ReadonlySet<string> = new Set([
  "Nexus",
  "CommandCenter",
  "OrbitalCommand",
  "PlanetaryFortress",
  "Hatchery",
  "Lair",
  "Hive",
]);

export function isTownHall(name: string): boolean {
  return TOWNHALL_NAMES.has(name);
}
