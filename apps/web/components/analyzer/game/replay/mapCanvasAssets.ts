import { isGasStructure, isTownHall, isWorkerUnit, worldProjection, type MapPlayback, type PlaybackBuilding } from "@/lib/mapReplay";
import { phaseOffset } from "@/lib/replayMotion";
import { hasWalk, resolveSprite, spriteAnim, type SpriteAnimHandle, type SpriteColor } from "@/lib/spriteSheets";

import type { PatchEra } from "@/lib/meta";

import { collectCreepSources, type CreepSource } from "@/lib/replayCreep";

import { getIconPath, type IconKind } from "@/lib/sc2-icons";

export const ME_ARMY = "#3ec0c7";
export const ME_WORKER = "rgba(62,192,199,0.45)";
export const OPP_ARMY = "#e05656";
export const OPP_WORKER = "rgba(224,86,86,0.45)";
/** Owner → team-coloured sheet variant. */
export const ME_SHEET: SpriteColor = "blue";
export const OPP_SHEET: SpriteColor = "red";
/** How long a battle marker pulses around its timestamp. */
export const BATTLE_WINDOW_SEC = 12;
/* Map furniture, in WORLD units so it keeps its size relative to the
 * terrain at every stage size and zoom — the same rule the sprites
 * follow. (These were raw canvas px before, which meant a spawn ring
 * covered a third of a base on a small stage and a hair on a big one.)
 */
export const RESOURCE_GLYPH_WORLD = 1.8;
export const ROCKS_GLYPH_WORLD = 2.3;
export const SPAWN_RING_WORLD = 6;
export const BATTLE_RING_MIN_WORLD = 4.5;
export const BATTLE_RING_GROW_WORLD = 6.5;
/** Floor for the furniture above, in on-screen CSS px, so a compact
 * stage doesn't render them sub-pixel. */
export const MIN_FURNITURE_SCREEN_PX = 9;

/* ──────────────── stage sizing ────────────────
 *
 * The old ``CANVAS_MAX_H_PX = 720`` ceiling is gone: the replay is the
 * centrepiece of the page, so the stage is sized like a video player —
 * as wide as its column, as tall as the viewport comfortably allows,
 * and always at the MAP's own aspect so nothing is letterboxed and the
 * whole canvas is playable ground.
 */
/** Fraction of the viewport height a full-size stage may occupy. */
export const STAGE_VIEWPORT_FRACTION = 0.78;
/** Absolute floor/ceiling so tiny and huge viewports both stay sane. */
export const STAGE_MIN_H_PX = 260;
export const STAGE_MAX_H_PX = 1080;
/** Padding, in canvas px, between the playable bounds and the canvas
 * edge. Tight: nearly every pixel of the stage shows map. */
export const STAGE_PAD_PX = 4;

/* ──────────────── sprite scale ────────────────
 *
 * ONE transform drives everything. ``worldProjection`` yields ``k``
 * pixels per world unit for the current canvas; a sprite's draw width
 * is ``worldUnitsPerCell × k``, full stop. That is what makes relative
 * unit sizes correct — and it is why nothing here has a hard-coded
 * per-unit or town-hall size any more.
 */
/** Global gain on sprite size. 1.0 is geometrically exact. Raising it
 * trades scale fidelity for legibility on small stages; do not. */
export const SPRITE_WORLD_GAIN = 1.0;
/** Floor on a sprite's on-SCREEN cell size, in CSS px. Only binds on
 * very small stages (a compact drilldown at k ≈ 3 would draw a Marine
 * 3.9 px wide); above it, relative scale is untouched. */
export const MIN_SPRITE_SCREEN_PX = 9;
/** Cell size in world units for names with no sprite sheet, so the
 * fallback icons stay in scale with the sprites around them. */
export const FALLBACK_UNIT_WORLD = 1.7;
export const FALLBACK_WORKER_WORLD = 1.5;
export const FALLBACK_BUILDING_WORLD = 3.7;
/** Top of the shared worldUnitsPerCell ladder (the Mothership's cell).
 * Used as the culling margin — no sprite can be wider than this. */
const WIDEST_SPRITE_WORLD = 13.7;

/* ──────────────── motion tuning ──────────────── */
/** Above this world-units/second a unit plays its Walk cycle. */
export const WALK_SPEED_THRESHOLD = 0.45;
/* ──────────────── fog of war ──────────────── */
export const FOG_ALPHA = 0.5;
/** Sight radii in world cells, loosely matching in-game vision. */
export const SIGHT_UNIT = 11;
export const SIGHT_WORKER = 9;
export const SIGHT_HALL = 13;
export const SIGHT_BUILDING = 10;
/**
 * Fog is a soft mask, so it is rendered at a FRACTION of stage
 * resolution and upscaled on composite — invisible on a gradient,
 * and it cuts the fog's fill rate by 1/scale². The reveal discs are
 * the single largest fill in the frame (a 500-unit frame stamps ~14
 * megapixels of soft disc at full resolution), so this is the
 * difference between fog being free and fog being the frame.
 */
export const FOG_RENDER_SCALE = 0.4;
/** Ceiling on the fog buffer's device-pixel ratio, on top of the
 * render scale — a 4K stage gains nothing from a 4K fog. */
export const FOG_MAX_DPR = 2;

/** Cover sprite footprints and vision for off-screen tracks. */
export const CULL_MARGIN_WORLD = Math.max(WIDEST_SPRITE_WORLD, SIGHT_UNIT);
/**
 * Sight sources are deduped on a spatial grid. The cell is a fraction
 * of the reveal RADIUS rather than a fixed pixel count, so the dedupe
 * gets no weaker as the stage grows or the view zooms.
 *
 * The fraction is bounded: two sources sharing a cell of side ``c``
 * are at most ``c·√2`` apart, and the kept source is fully opaque out
 * to ``FOG_MASK_INNER · r``. So any fraction ≤ 0.55/√2 = 0.389
 * guarantees a dropped source still sits inside a kept source's solid
 * core and the union is visually unchanged. 0.35 keeps margin.
 */
export const FOG_DEDUPE_RADIUS_FRACTION = 0.35;
/** Resolution of the cached reveal mask. The falloff is smooth, so a
 * 128 px stamp scales to any sight radius invisibly — and blitting a
 * stamp costs a fraction of building a radial gradient per reveal
 * (measured: ~2.5 ms/frame on a 600-source frame). */
const FOG_MASK_PX = 128;
/** Where the reveal starts fading, as a fraction of the radius. */
const FOG_MASK_INNER = 0.55;

/** Edge vignette. Replaces the old flat ``LAYOUT_VEIL`` global dim:
 * the terrain now shows at full colour, and only the outer edge is
 * darkened so the stage separates from the page chrome. */
export const VIGNETTE_ALPHA = 0.42;
/** Fraction of the half-diagonal at which the vignette starts. */
export const VIGNETTE_INNER = 0.62;

/* ──────────────── fallback icon caches ────────────────
 *
 * Module-level so every replayer instance (game page + macro
 * drilldown) shares one decoded image per icon. ``null`` marks a
 * failed load; entries are only drawn once fully decoded, so a frame
 * rendered before an icon arrives falls back to the dot marker and
 * picks the icon up on a later frame. Only names with NO sprite sheet
 * reach this path.
 */

const iconElementCache = new Map<string, HTMLImageElement | null>();
/** Memoized ``getIconPath`` — name→path resolution does string
 * normalization, too hot to repeat per marker per rAF frame. */
const iconPathCache = new Map<string, string | null>();
/** Bumped whenever an icon or the layout render finishes (or fails)
 * loading. The draw loop uses it as a dirty flag so a PAUSED replay
 * stops re-rendering every frame — a real battery cost on mobile —
 * while still picking up late-decoding assets. */
export let assetsVersion = 0;

function resolveIconPath(name: string, kind: IconKind): string | null {
  const key = `${kind}:${name}`;
  let path = iconPathCache.get(key);
  if (path === undefined) {
    path = getIconPath(name, kind);
    iconPathCache.set(key, path);
  }
  return path;
}

function readyIcon(name: string, kind: IconKind): HTMLImageElement | null {
  const path = resolveIconPath(name, kind);
  if (!path) return null;
  let img = iconElementCache.get(path);
  if (img === undefined) {
    if (typeof Image === "undefined") return null; // non-DOM test envs
    img = new Image();
    img.decoding = "async";
    img.onload = () => {
      assetsVersion += 1;
    };
    img.onerror = () => {
      iconElementCache.set(path, null);
      assetsVersion += 1;
    };
    img.src = path;
    iconElementCache.set(path, img);
  }
  return img && img.complete && img.naturalWidth > 0 ? img : null;
}

/** Team-tinted flat icons — the fallback for names with no sprite
 * sheet. Bare unit art (the PNGs carry real transparency) washed
 * toward the owner colour via source-atop, no ring, box, or backing.
 * Pre-rendered once per (icon, tint, size, dpr). */
const unitTokenCache = new Map<string, HTMLCanvasElement>();
/** How strongly the owner colour washes the icon art. */
const TINT_ALPHA = 0.42;

export function iconToken(
  name: string,
  kind: IconKind,
  tint: string,
  sizePx: number,
  dpr: number,
): HTMLCanvasElement | null {
  const icon = readyIcon(name, kind);
  if (!icon) return null;
  const path = resolveIconPath(name, kind);
  const key = `${path}|${tint}|${sizePx}|${dpr}`;
  const cached = unitTokenCache.get(key);
  if (cached) return cached;
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sizePx * dpr));
  c.height = c.width;
  const g = c.getContext("2d");
  if (!g) return null;
  g.scale(dpr, dpr);
  g.drawImage(icon, 0, 0, sizePx, sizePx);
  // source-atop confines the fill to the icon's own alpha, so only
  // the unit art itself takes the team colour.
  g.globalCompositeOperation = "source-atop";
  g.globalAlpha = TINT_ALPHA;
  g.fillStyle = tint;
  g.fillRect(0, 0, sizePx, sizePx);
  unitTokenCache.set(key, c);
  return c;
}

const glyphCache = new Map<string, HTMLCanvasElement>();

export function resourceGlyph(kind: string, dpr: number): HTMLCanvasElement | null {
  const key = `${kind}|${dpr}`;
  const cached = glyphCache.get(key);
  if (cached) return cached;
  if (typeof document === "undefined") return null;
  const S = 14;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(S * dpr));
  c.height = c.width;
  const g = c.getContext("2d");
  if (!g) return null;
  g.scale(dpr, dpr);
  const diamond = (cx: number, cy: number, w: number, h: number, fill: string, top: string) => {
    g.beginPath();
    g.moveTo(cx, cy - h / 2);
    g.lineTo(cx + w / 2, cy);
    g.lineTo(cx, cy + h / 2);
    g.lineTo(cx - w / 2, cy);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    g.beginPath();
    g.moveTo(cx, cy - h / 2);
    g.lineTo(cx + w / 2, cy);
    g.lineTo(cx - w / 2, cy);
    g.closePath();
    g.fillStyle = top;
    g.fill();
  };
  if (kind === "minerals" || kind === "gold") {
    const base = kind === "gold" ? "#c9992e" : "#3f7fd6";
    const glint = kind === "gold" ? "#ffd97a" : "#9cc8ff";
    diamond(4.4, 8.6, 6, 8, base, glint);
    diamond(9.8, 8.2, 6.5, 9, base, glint);
    diamond(7, 5.4, 5, 6.5, base, glint);
  } else if (kind === "gas") {
    g.beginPath();
    g.ellipse(7, 8, 5.6, 4.2, 0, 0, Math.PI * 2);
    g.fillStyle = "#3a4a41";
    g.fill();
    g.beginPath();
    g.ellipse(7, 7.4, 3.1, 2.3, 0, 0, Math.PI * 2);
    g.fillStyle = "#57c785";
    g.fill();
    g.beginPath();
    g.ellipse(6.2, 6.8, 1.1, 0.8, 0, 0, Math.PI * 2);
    g.fillStyle = "#b6f0cd";
    g.fill();
  } else if (kind === "rocks") {
    g.beginPath();
    g.moveTo(2.5, 9.5);
    g.lineTo(4.5, 4.5);
    g.lineTo(8, 3.4);
    g.lineTo(11.6, 5.6);
    g.lineTo(11.2, 10);
    g.lineTo(6.5, 11.4);
    g.closePath();
    g.fillStyle = "#6e6a5e";
    g.fill();
    g.beginPath();
    g.moveTo(4.5, 4.5);
    g.lineTo(8, 3.4);
    g.lineTo(9.4, 6.8);
    g.lineTo(5.6, 7.6);
    g.closePath();
    g.fillStyle = "#8d887a";
    g.fill();
  } else {
    // Xel'Naga tower: watch ring.
    g.beginPath();
    g.arc(7, 7, 4.4, 0, Math.PI * 2);
    g.strokeStyle = "#cfcab2";
    g.lineWidth = 1.4;
    g.stroke();
    g.beginPath();
    g.arc(7, 7, 1.5, 0, Math.PI * 2);
    g.fillStyle = "#cfcab2";
    g.fill();
  }
  glyphCache.set(key, c);
  return c;
}

/* ──────────────── per-payload derived data ──────────────── */

interface Derived {
  creepSources: CreepSource[];
  /** Track bounding box per unit, in world units — lets a zoomed-in
   * frame skip interpolating a unit that can never be on screen. */
  trackBox: Float32Array;
  /** Per-unit facing, carried across frames so the hysteresis in
   * ``facingFromVelocity`` has something to be sticky about. */
  /** Per-unit animation phase, so a pack of Zerglings never marches
   * in lockstep. Deterministic in the payload index. */
  phase: Float32Array;
  /** Sheet handles resolved ONCE per payload. Name → sheet resolution
   * and URL building are string work; doing them per unit per frame
   * would be 60 000 string operations a second for nothing. Null means
   * no sheet ships for that name → the flat-icon fallback. */
  unitStand: Array<SpriteAnimHandle | null>;
  unitWalk: Array<SpriteAnimHandle | null>;
  unitWorker: Uint8Array;
  buildingStand: Array<SpriteAnimHandle | null>;
  buildingHall: Uint8Array;
  buildingPhase: Float32Array;
  /** Just the vespene structures, so the per-frame "is this geyser
   *  tapped?" guard rescans ~1% of the building list instead of all of
   *  it, once per gas node, every frame. */
  gasBuildings: PlaybackBuilding[];
}

const derivedCache = new WeakMap<MapPlayback, Derived>();

export function derivedOf(playback: MapPlayback): Derived {
  let d = derivedCache.get(playback);
  if (!d) {
    const n = playback.units.length;
    const trackBox = new Float32Array(n * 4);
    const phase = new Float32Array(n);
    const unitStand: Array<SpriteAnimHandle | null> = new Array(n);
    const unitWalk: Array<SpriteAnimHandle | null> = new Array(n);
    const unitWorker = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      const u = playback.units[i];
      const worker = isWorkerUnit(u.name);
      unitWorker[i] = worker ? 1 : 0;
      const sprite = resolveSprite(u.name, "unit");
      unitStand[i] = sprite ? spriteAnim(sprite, "Stand") : null;
      // Carrier, SiegeTank and Tempest have no walk cycle; spriteAnim
      // already falls back to Stand, so this is never null when the
      // sprite exists and the Walk/Stand switch is a plain pick.
      unitWalk[i] = sprite ? spriteAnim(sprite, hasWalk(sprite) ? "Walk" : "Stand") : null;
      phase[i] = phaseOffset(i);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const wp = u.wp;
      for (let j = 1; j + 1 < wp.length; j += 3) {
        const x = wp[j];
        const y = wp[j + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      trackBox[i * 4] = minX;
      trackBox[i * 4 + 1] = minY;
      trackBox[i * 4 + 2] = maxX;
      trackBox[i * 4 + 3] = maxY;
    }
    const bn = playback.buildings.length;
    const buildingStand: Array<SpriteAnimHandle | null> = new Array(bn);
    const buildingHall = new Uint8Array(bn);
    const buildingPhase = new Float32Array(bn);
    const gasBuildings: PlaybackBuilding[] = [];
    for (let i = 0; i < bn; i += 1) {
      const b = playback.buildings[i];
      const sprite = resolveSprite(b.name, "building");
      buildingStand[i] = sprite ? spriteAnim(sprite, "Stand") : null;
      buildingHall[i] = isTownHall(b.name) ? 1 : 0;
      buildingPhase[i] = phaseOffset(i * 2654435761);
      if (isGasStructure(b.name)) gasBuildings.push(b);
    }
    d = {
      creepSources: collectCreepSources(playback),
      trackBox,
      phase,
      unitStand,
      unitWalk,
      unitWorker,
      buildingStand,
      buildingHall,
      buildingPhase,
      gasBuildings,
    };
    derivedCache.set(playback, d);
  }
  return d;
}

/** Reusable offscreen fog canvas — resized on demand, redrawn each
 * rendered frame (the draw loop is already dirty-checked). */
/** One cached reveal stamp, blitted at whatever radius each sight
 * source needs. The falloff profile is a ratio, so it is the same
 * shape for every radius and every zoom — one canvas covers all. */
let fogMaskCanvas: HTMLCanvasElement | null = null;

export function fogMask(): HTMLCanvasElement | null {
  if (fogMaskCanvas) return fogMaskCanvas;
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = FOG_MASK_PX;
  c.height = FOG_MASK_PX;
  const g = c.getContext("2d");
  if (!g) return null;
  const r = FOG_MASK_PX / 2;
  const grad = g.createRadialGradient(r, r, r * FOG_MASK_INNER, r, r, r);
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.beginPath();
  g.arc(r, r, r, 0, Math.PI * 2);
  g.fill();
  fogMaskCanvas = c;
  return c;
}

export interface ViewTransform {
  z: number;
  ox: number;
  oy: number;
}

/* ──────────────── draw entities ────────────────
 *
 * Units and buildings go into ONE list and are painted back-to-front
 * by their ground point's screen Y, so a Marine standing in front of a
 * Barracks draws over it — the whole reason the sprites read as 3D.
 * The list is a pooled array of mutable records: a 500-unit frame
 * allocates nothing after the first.
 */

export function bumpReplayAssetsVersion(): void { assetsVersion += 1; }
