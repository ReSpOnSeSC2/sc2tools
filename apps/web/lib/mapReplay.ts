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
}

export interface PlaybackUnit {
  owner: "me" | "opp";
  name: string;
  born: number;
  died: number | null;
  /** Flat [t, x, y, t, x, y, …], ascending t. */
  wp: number[];
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
    buildings.push({
      owner: o,
      name: typeof r.name === "string" ? r.name.slice(0, 40) : "",
      t: Number.isFinite(num(r.t)) ? num(r.t) : 0,
      x,
      y,
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
  const statsIn = (p.stats ?? {}) as Record<string, unknown>;
  const side = (v: unknown): number[][] =>
    (Array.isArray(v) ? v.slice(0, 800) : [])
      .filter((row): row is number[] => Array.isArray(row) && row.length >= 2)
      .map((row) => row.map((c) => num(c)))
      .filter((row) => row.every((c) => Number.isFinite(c)));
  const gameLength = Math.max(
    Number.isFinite(num(p.gameLength)) ? num(p.gameLength) : 0,
    ...units.map((u) => u.died ?? u.wp[u.wp.length - 3]),
    1,
  );
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
    stats: { me: side(statsIn.me), opp: side(statsIn.opp) },
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
 */
export function unitPositionAt(
  wp: readonly number[],
  t: number,
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
    const f = (t - t0) / (t1 - t0);
    return {
      x: wp[i + 1] + (wp[i + 4] - wp[i + 1]) * f,
      y: wp[i + 2] + (wp[i + 5] - wp[i + 2]) * f,
    };
  }
  return { x: wp[last + 1], y: wp[last + 2] };
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
const WORKER_NAMES = new Set(["Probe", "SCV", "Drone", "MULE"]);

export function isWorkerUnit(name: string): boolean {
  return WORKER_NAMES.has(name);
}

/** Town-hall names render as the biggest building squares. */
const TOWNHALL_NAMES = new Set([
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
