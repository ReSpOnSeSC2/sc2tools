/**
 * mapReplay — pure data layer for the vespene.gg-style map replayer.
 *
 * The agent uploads a compact playback payload per game (see the
 * pipeline's ``_compact_map_playback``): per-unit waypoint tracks as
 * flat ``[t, x, y, …]`` arrays in SC2 world coordinates, building
 * placements, battle markers, spawn anchors, per-side stats series
 * and the map's playable bounds. Everything here is deterministic
 * math — interpolation and world→canvas projection — so the canvas
 * component stays a thin draw loop and the hard parts unit-test.
 */

import { motionSample, sampleTrack } from "./replayMotion";

export interface PlaybackForm {
  t: number;
  name: string;
}

export type ReplayUnitId = number | string;

export interface ReplayCreep {
  width: number;
  height: number;
  encoding: "rle";
  frames: Array<{ t: number; runs: number[] }>;
}

export interface ReplayObservedEffect {
  id: number;
  name: string;
  owner: "me" | "opp" | "neutral";
  t: number;
  end: number;
  x: number;
  y: number;
  radius: number;
}

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
  /** Observed weapon cycles; aim contains only confirmed target positions. */
  attacks?: number[];
  aim?: number[];
  id?: ReplayUnitId;
  forms?: PlaybackForm[];
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
  /** Observed weapon cycles; aim is flat [shotTime, targetX, targetY, …]. */
  attacks?: number[];
  aim?: number[];
  /** Stable replay tag; type changes do not create a second unit. */
  id?: ReplayUnitId;
  /** Intervals spent in a transport or absent from engine observations. */
  hidden?: number[];
  forms?: PlaybackForm[];
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
  casterUnitId?: ReplayUnitId;
  casterUnitIds?: ReplayUnitId[];
  targetUnitId?: ReplayUnitId;
  source?: "command" | "observation";
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
  creep?: ReplayCreep;
  effects?: ReplayObservedEffect[];
  fidelity?: {
    positions: "tracker" | "engine";
    paths: "observed";
    creep: "estimated" | "observed";
    effects?: "observed" | "unavailable";
    attacks?: "observed" | "unavailable";
    positionError?: number;
    sampleSeconds?: number;
    complete?: boolean;
  };
  /** Per-side [t, armyValue, workers, supplyUsed] rows, ascending t. */
  stats: { me: number[][]; opp: number[][] };
}

/** Strict re-sanitize of the wire payload — the canvas must render
 *  safely even if a hostile blob reaches the endpoint. */
export function sanitizeMapPlayback(raw: unknown): MapPlayback | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const b = p.bounds as Record<string, unknown> | undefined;
  const num = (v: unknown): number =>
    v !== null && v !== undefined && v !== "" && typeof v !== "boolean" && Number.isFinite(Number(v))
      ? Number(v) : NaN;
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
    !Number.isFinite(bounds.maxX) ||
    !Number.isFinite(bounds.maxY) ||
    bounds.maxX <= bounds.minX ||
    bounds.maxY <= bounds.minY
  ) {
    return null;
  }
  const owner = (v: unknown): "me" | "opp" | null =>
    v === "me" || v === "opp" ? v : null;
  const tag = (v: unknown): ReplayUnitId | undefined => {
    if (typeof v === "string" && /^[0-9]{1,20}$/.test(v)) return v;
    const n = num(v);
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  };
  const formsIn = (v: unknown): PlaybackForm[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const forms = v.slice(0, 512).filter((f) => f && Number.isFinite(num(f.t)) &&
      num(f.t) >= 0 && typeof f.name === "string" && f.name.length > 0)
      .map((f) => ({ t: num(f.t), name: f.name.slice(0, 40) as string }))
      .sort((a, b) => a.t - b.t);
    return forms.length ? forms : undefined;
  };
  const waypointsIn = (v: unknown, cap: number): number[] => {
    if (!Array.isArray(v)) return [];
    const points: Array<[number, number, number]> = [];
    for (let i = 0; i + 2 < Math.min(v.length, cap * 3); i += 3) {
      const point: [number, number, number] = [num(v[i]), num(v[i + 1]), num(v[i + 2])];
      if (point.every(Number.isFinite) && point[0] >= 0) points.push(point);
    }
    points.sort((a, b) => a[0] - b[0]);
    const flat: number[] = [];
    for (const point of points) {
      if (flat.length && flat[flat.length - 3] === point[0]) flat.splice(flat.length - 3, 3);
      flat.push(...point);
    }
    return flat;
  };
  const units: PlaybackUnit[] = [];
  let remainingPoints = 200000;
  let truncated = Array.isArray(p.units) && p.units.length > 4000;
  let remainingAttacks = 200000;
  const attacksIn = (r: Record<string, unknown>, born: number, died: number) => {
    const coverage = p.fidelity as Record<string, unknown> | undefined;
    if (coverage?.positions !== "engine" || coverage.attacks !== "observed" || !Array.isArray(r.attacks)) return {};
    const shots = [...new Set(r.attacks.slice(0, Math.min(16384, remainingAttacks)).map(num)
      .filter((t) => Number.isFinite(t) && t >= born && (!Number.isFinite(died) || t < died)))].sort((a, b) => a - b);
    if (shots.length < r.attacks.length) truncated = true;
    remainingAttacks -= shots.length;
    const shotSet = new Set(shots);
    const aim = waypointsIn(r.aim, shots.length).filter((_, i, points) => shotSet.has(points[i - i % 3]));
    if (Array.isArray(r.aim) && aim.length < r.aim.length) truncated = true;
    return { attacks: shots, ...(aim.length ? { aim } : {}) };
  };
  for (const u of Array.isArray(p.units) ? p.units.slice(0, 4000) : []) {
    if (!u || typeof u !== "object") continue;
    const r = u as Record<string, unknown>;
    const o = owner(r.owner);
    const wp = waypointsIn(r.wp, Math.min(16384, remainingPoints));
    if (Array.isArray(r.wp) && wp.length < r.wp.length) truncated = true;
    remainingPoints -= wp.length / 3;
    if (!o || wp.length === 0) continue;
    // ``num`` alone is a trap for born/died: the wire encodes "still
    // alive" as ``died: null`` and ``Number(null)`` is 0, which would
    // mark every surviving unit dead at t=0 and hide it for the whole
    // playback. Treat null/undefined as absent BEFORE coercing.
    const born = r.born === null || r.born === undefined ? NaN : num(r.born);
    const died = r.died === null || r.died === undefined ? NaN : num(r.died);
    units.push({
      ...(tag(r.id) !== undefined ? { id: tag(r.id) } : {}),
      ...(formsIn(r.forms) ? { forms: formsIn(r.forms) } : {}),
      ...(Array.isArray(r.hidden) ? { hidden: r.hidden.slice(0, 16384).map(num) } : {}),
      ...attacksIn(r, Number.isFinite(born) ? born : wp[0], died),
      owner: o,
      name: typeof r.name === "string" ? r.name.slice(0, 40) : "",
      born: Number.isFinite(born) ? born : wp[0],
      died: Number.isFinite(died) ? died : null,
      ...(r.sd === true ? { sd: true } : {}),
      wp,
    });
  }
  const buildings: PlaybackBuilding[] = [];
  if (Array.isArray(p.buildings) && p.buildings.length > 1000) truncated = true;
  for (const bd of Array.isArray(p.buildings) ? p.buildings.slice(0, 1000) : []) {
    if (!bd || typeof bd !== "object") continue;
    const r = bd as Record<string, unknown>;
    const o = owner(r.owner);
    const x = num(r.x);
    const y = num(r.y);
    if (!o || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const moves = waypointsIn(r.moves, 16384);
    if (Array.isArray(r.moves) && moves.length < r.moves.length) truncated = true;
    const bDied = r.died === null || r.died === undefined ? NaN : num(r.died);
    buildings.push({
      ...(tag(r.id) !== undefined ? { id: tag(r.id) } : {}),
      ...(formsIn(r.forms) ? { forms: formsIn(r.forms) } : {}),
      ...attacksIn(r, Number.isFinite(num(r.t)) ? num(r.t) : 0, bDied),
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
  if (Array.isArray(p.casts) && p.casts.length > 2000) truncated = true;
  for (const cs of Array.isArray(p.casts) ? p.casts.slice(0, 2000) : []) {
    if (!cs || typeof cs !== "object") continue;
    const r = cs as Record<string, unknown>;
    if (typeof r.a !== "string" || r.a.length === 0) continue;
    const t = num(r.t);
    if (!Number.isFinite(t)) continue;
    if (num(r.o) !== 0 && num(r.o) !== 1) continue;
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
    if (tag(r.casterUnitId) !== undefined) cast.casterUnitId = tag(r.casterUnitId);
    if (tag(r.targetUnitId) !== undefined) cast.targetUnitId = tag(r.targetUnitId);
    if (Array.isArray(r.casterUnitIds)) {
      cast.casterUnitIds = [...new Set(r.casterUnitIds.slice(0, 128).map(tag)
        .filter((id): id is ReplayUnitId => id !== undefined))];
    }
    if (r.source === "command" || r.source === "observation") cast.source = r.source;
    casts.push(cast);
  }
  if (units.length === 0 && buildings.length === 0) return null;
  const f = p.fidelity as Record<string, unknown> | undefined;
  const fidelity: MapPlayback["fidelity"] = f && (f.positions === "tracker" || f.positions === "engine")
    ? { positions: f.positions, paths: "observed", creep: f.creep === "observed" ? "observed" : "estimated",
      ...(f.effects === "observed" || f.effects === "unavailable" ? { effects: f.effects } : {}),
      ...(f.attacks === "observed" || f.attacks === "unavailable" ? { attacks: f.attacks } : {}),
      ...(Number.isFinite(num(f.positionError)) && num(f.positionError) >= 0 ? { positionError: num(f.positionError) } : {}),
      ...(Number.isFinite(num(f.sampleSeconds)) && num(f.sampleSeconds) > 0 ? { sampleSeconds: num(f.sampleSeconds) } : {}),
      ...(typeof f.complete === "boolean" || truncated ? { complete: !truncated && f.complete === true } : {}) } : undefined;
  const cr = p.creep as Record<string, unknown> | undefined;
  let creep: ReplayCreep | undefined;
  if (cr && cr.encoding === "rle" && Number.isInteger(cr.width) && Number.isInteger(cr.height) &&
      num(cr.width) > 0 && num(cr.height) > 0 && num(cr.width) <= 512 && num(cr.height) <= 512 && Array.isArray(cr.frames)) {
    const width = num(cr.width), height = num(cr.height);
    let runsLeft = 1000000;
    if (cr.frames.length > 12000) truncated = true;
    const frames: ReplayCreep["frames"] = [];
    for (const rawFrame of cr.frames.slice(0, 12000)) {
      if (!rawFrame || !Number.isFinite(num(rawFrame.t)) || num(rawFrame.t) < 0 || !Array.isArray(rawFrame.runs)) continue;
      const runs: number[] = [];
      if (rawFrame.runs.length > runsLeft || rawFrame.runs.length % 2) { truncated = true; break; }
      let valid = true, previousEnd = 0;
      for (let i = 0; i < rawFrame.runs.length; i += 2) {
        const start = num(rawFrame.runs[i]), length = num(rawFrame.runs[i + 1]);
        if (!Number.isInteger(start) || !Number.isInteger(length) || start < previousEnd || length <= 0 || start + length > width * height) { valid = false; break; }
        runs.push(start, length);
        previousEnd = start + length;
      }
      if (valid) { frames.push({ t: num(rawFrame.t), runs }); runsLeft -= runs.length; }
      else truncated = true;
    }
    if (frames.length) creep = { width, height, encoding: "rle", frames: frames.sort((a, b) => a.t - b.t) };
  }
  const effects: ReplayObservedEffect[] = [];
  if (Array.isArray(p.effects) && p.effects.length > 20000) truncated = true;
  for (const e of Array.isArray(p.effects) ? p.effects.slice(0, 20000) : []) {
    if (!e || (!owner(e.owner) && e.owner !== "neutral") || typeof e.name !== "string" ||
        ![e.id, e.t, e.end, e.x, e.y, e.radius].every((n) => Number.isFinite(num(n))) ||
        num(e.t) < 0 || num(e.end) <= num(e.t) || num(e.radius) < 0 || num(e.radius) > 100) { truncated = true; continue; }
    effects.push({ id: num(e.id), name: e.name.slice(0, 80), owner: e.owner === "neutral" ? "neutral" : owner(e.owner)!,
      t: num(e.t), end: num(e.end), x: num(e.x), y: num(e.y), radius: num(e.radius) });
  }
  if (fidelity && truncated) fidelity.complete = false;
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
    ...(fidelity ? { fidelity } : {}),
    ...(creep ? { creep } : {}),
    ...(Array.isArray(p.effects) ? { effects: effects.sort((a, b) => a.t - b.t) } : {}),
    ...(casts.length ? { casts } : {}),
    stats: { me: statsMe, opp: statsOpp },
  };
}

/** Is the unit alive (born ≤ t, not yet died) at time t? */
export function unitAliveAt(unit: PlaybackUnit, t: number): boolean {
  if (unit.born > t) return false;
  return unit.died === null || unit.died > t;
}

/** Loaded units remain alive but have no map sprite while in cargo. */
export function unitVisibleAt(unit: PlaybackUnit, t: number): boolean {
  if (!unitAliveAt(unit, t)) return false;
  for (let i = 0; i + 1 < (unit.hidden?.length ?? 0); i += 2) {
    if (unit.hidden![i] <= t && t < unit.hidden![i + 1]) return false;
  }
  return true;
}

/** Resolve the form at the requested time; never show a future morph early. */
export function unitNameAt(unit: { name: string; forms?: PlaybackForm[] }, t: number): string {
  let name = unit.name;
  for (const form of unit.forms ?? []) {
    if (form.t > t) break;
    name = form.name;
  }
  return name;
}

/** Shared observed-position sampler for sprites, effects and HUD. */
export function unitPositionAt(
  wp: readonly number[],
  t: number,
  maxSpeed?: number,
): { x: number; y: number } | null {
  const result = sampleTrack(wp, t, maxSpeed, motionSample());
  return result ? { x: result.x, y: result.y } : null;
}

/**
 * Discontinuity guard for sparse tracker positions, in world cells/sec.
 * Engine tracks already preserve actual movement and teleport boundaries;
 * use the exporter's guard so fast units and speed upgrades do not freeze
 * between valid samples. This is not a movement simulation speed.
 */
export function unitMaxSpeed(name: string, observed = false): number {
  if (observed) return 14;
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
 * Sample recorded building positions. Sparse tracker gaps hold their last
 * anchor; observed engine movement uses the same discontinuity guard as
 * units, including upgraded flying buildings and uprooted Zerg structures.
 */
const buildingTracks = new WeakMap<PlaybackBuilding, number[]>();

export function buildingPositionAt(
  b: PlaybackBuilding,
  t: number,
  observed = false,
): { x: number; y: number } {
  if (b.moves.length === 0) return { x: b.x, y: b.y };
  let wp = buildingTracks.get(b);
  if (!wp) {
    wp = [b.t, b.x, b.y, ...b.moves];
    buildingTracks.set(b, wp);
  }
  return unitPositionAt(wp, t, observed ? 14 : BUILDING_FLY_SPEED) ?? { x: b.x, y: b.y };
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
