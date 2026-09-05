/**
 * spriteSheets — registry + draw path for the 3D-rendered SC2 sprite
 * sheets the map replayer draws units and buildings with.
 *
 * The assets are 103 sheets rendered from the real ``.m3`` models in
 * Blender (54 units, 49 buildings), each a grid of ``frameSize`` px
 * cells plus a JSON sidecar. The sidecars are baked into
 * ``spriteManifest.generated.ts`` at build time (see
 * ``scripts/gen-sprite-manifest.mjs``) so geometry is available
 * synchronously on the first frame; only the ``.webp`` sheets are
 * fetched at runtime, from ``NEXT_PUBLIC_SPRITE_BASE``.
 *
 * The sheet contract, honoured verbatim:
 *
 *   grid       cell index = ``facing * cols + frame``, laid out
 *              left-to-right then top-to-bottom. For units cols = 8 =
 *              frames and facings = 8, so row = facing and col =
 *              frame; for buildings facings = 1, so the index is just
 *              the frame on a 4x2 (animated) or 1x1 (static) grid.
 *              Everything is driven from the manifest's cols/rows —
 *              nothing assumes 8x8.
 *   facings    8 for units, 1 for buildings. BUILDINGS NEVER ROTATE.
 *   wupc       worldUnitsPerCell: the horizontal (map-X) width of one
 *              cell in SC2 world units, on a quantised ladder shared
 *              by units AND buildings. Draw width = wupc x pixels per
 *              world unit — this is what makes a Thor 6.2x a Marine.
 *   anchor     the pixel inside the cell where the model's ground
 *              origin projects. That pixel lands on the unit's map
 *              coordinate; centring the bitmap instead sinks
 *              everything below the ground.
 *   Walk       carries its OWN wupc and anchor (a walk pose has a
 *              different silhouette and was framed independently), so
 *              per-anim values win over the sheet-level ones.
 *
 * Performance strategy: never let the browser resample a 2048² sheet
 * per unit per frame. Sheets are decoded once into an ``ImageBitmap``,
 * then pre-scaled into a power-of-two "size bucket" atlas — the whole
 * grid at the size it will actually be drawn — and the draw loop blits
 * one small cell per unit. Because every bucket divides the source
 * exactly (frameSize and bucket are both powers of two), the downscale
 * is a chain of exact 2:1 halvings: no resampling artefacts. Atlases
 * are evicted LRU against a byte budget, and only a couple are built
 * per frame so a new unit type appearing never stalls a frame.
 */

import {
  SPRITE_MANIFEST,
  type SpriteAnimMeta,
  type SpriteSheetMeta,
} from "./spriteManifest.generated";
import { SPRITE_ICON_FILL } from "./spriteIconFit.generated";

export type { SpriteAnimMeta, SpriteSheetMeta };

/** Owner colour → sheet variant. The streamer is cyan-coded in the
 * overlay language, the opponent red, so "me" takes the blue sheets. */
export type SpriteColor = "red" | "blue";

/**
 * Where the sheets are served from. Defaults to a relative path so a
 * dev build can drop them in ``public/sprites``; production points
 * this at the CDN. Never hard-code an absolute URL anywhere else.
 */
export const SPRITE_BASE = (
  process.env.NEXT_PUBLIC_SPRITE_BASE || "/sprites"
).replace(/\/+$/, "");

/**
 * URL of one sheet. ``anim`` is the manifest's ``suffix``: null for the
 * default sheet, "Walk"/"Birth" for the per-anim sheets. The sidecars
 * name ``.png`` files; the shipped assets are ``.webp``, so the
 * extension is substituted here and nowhere else.
 */
export function spriteUrl(
  kind: "unit" | "building",
  race: string,
  name: string,
  color: SpriteColor,
  anim: string | null,
): string {
  const dir = kind === "unit" ? "units" : "buildings";
  const suffix = anim ? `_${anim}` : "";
  // Authored attack sheets ship with the web release. Their URLs must not
  // depend on a separately published CDN asset.
  const base = anim === "Attack" ? "/replay-attacks" : SPRITE_BASE;
  return `${base}/${dir}/${race}/${name}_${color}${suffix}.webp`;
}

/* ──────────────── name resolution ──────────────── */

/**
 * Playback names that don't match a sheet name directly. The replay
 * tracker emits mode/state variants (a sieged tank, a burrowed roach,
 * a lifted Command Center) as distinct unit names; they all render
 * from the base model's sheet.
 */
const SPRITE_ALIASES: Readonly<Record<string, string>> = {
  VikingFighter: "Viking",
  VikingAssault: "Viking",
  SiegeTankSieged: "SiegeTank",
  ThorAP: "Thor",
  LiberatorAG: "Liberator",
  HellionTank: "Hellbat",
  WidowMineBurrowed: "WidowMine",
  OrbitalCommandFlying: "OrbitalCommand",
  CommandCenterFlying: "CommandCenter",
  BarracksFlying: "Barracks",
  FactoryFlying: "Factory",
  StarportFlying: "Starport",
  SupplyDepotLowered: "SupplyDepot",
  RefineryRich: "Refinery",
  LurkerMP: "Lurker",
  LurkerMPBurrowed: "Lurker",
  SwarmHostMP: "SwarmHost",
  SwarmHostBurrowedMP: "SwarmHost",
  OverlordTransport: "Overlord",
  OverseerSiegeMode: "Overseer",
  ExtractorRich: "Extractor",
  SpineCrawlerUprooted: "SpineCrawler",
  SporeCrawlerUprooted: "SporeCrawler",
  BanelingBurrowed: "Baneling",
  ObserverSiegeMode: "Observer",
  WarpPrismPhasing: "WarpPrism",
  AdeptPhaseShift: "Adept",
  AssimilatorRich: "Assimilator",
  MothershipCore: "Mothership",
  BattleCruiser: "Battlecruiser",
  Battlecruiser: "Battlecruiser",
  // Terran add-ons. The tracker names these per parent structure
  // (BarracksTechLab, FactoryReactor, StarportTechLab, ...) but SC2
  // ships exactly ONE techlab.m3 and ONE reactor.m3 -- every parent
  // reuses the same add-on model -- so they all fold onto the two
  // sheets we baked. ``lib/sc2-icons.ts`` already does the identical
  // fold for the flat roster icons; without it here the map dropped
  // straight to that flat icon instead of the sprite.
  BarracksTechLab: "TechLab",
  BarracksReactor: "Reactor",
  FactoryTechLab: "TechLab",
  FactoryReactor: "Reactor",
  StarportTechLab: "TechLab",
  StarportReactor: "Reactor",
  TechLabReactor: "Reactor",
};

/** Suffixes the tracker appends for a temporary state; the base model
 * is the right art for all of them. Stripped after the alias table so
 * an explicit mapping always wins. */
const STATE_SUFFIXES = ["Burrowed", "Flying", "Sieged", "Lowered", "Uprooted", "Rich", "MP"];

/**
 * Sprites the payload files under EITHER list depending on the engine's
 * structure classification, so the ``kind`` guard below must not reject
 * them. An Auto-Turret is a unit that behaves like a structure; creep
 * tumours and the Nydus worm are structures that arrive as unit births.
 * Sheet names are globally unique, so waiving the guard here cannot
 * cross-wire a unit onto a building's art.
 */
const DUAL_KIND_SPRITES: ReadonlySet<string> = new Set([
  "AutoTurret",
  "CreepTumor",
  "CreepTumorBurrowed",
  "NydusCanal",
  "ForceField",
  "StasisWard",
]);

export interface ResolvedSprite {
  /** Canonical sheet name, e.g. "SiegeTank" for "SiegeTankSieged". */
  readonly name: string;
  readonly meta: SpriteSheetMeta;
  /** Lazily filled by ``spriteAnim`` — see ``SpriteAnimHandle``. */
  readonly handles: Record<string, SpriteAnimHandle>;
}

/**
 * Everything the draw path needs for one (sprite, anim), resolved
 * ONCE. In particular both sheet URLs are pre-built: a 500-unit frame
 * would otherwise concatenate 500 strings per frame just to look up a
 * cache entry.
 */
export interface SpriteAnimHandle {
  readonly sprite: ResolvedSprite;
  /** "Stand" or "Walk" — the anim actually resolved, after fallback. */
  readonly name: string;
  readonly anim: SpriteAnimMeta;
  readonly redUrl: string;
  readonly blueUrl: string;
}

const resolveCache = new Map<string, ResolvedSprite | null>();
const nameCache = new Map<string, string | null>();

/**
 * Playback name → canonical sheet name, or null when nothing ships for
 * it. THE alias authority: the map's ``resolveSprite`` and the DOM
 * roster icons both go through here, so ``BarracksTechLab`` resolves to
 * ``TechLab`` in exactly one place. Deliberately kind-agnostic — a
 * roster row knows "unit" / "structure" in the HUD's vocabulary, not
 * the payload list a name came from, and sheet names are globally
 * unique so the fold is unambiguous without it.
 */
export function canonicalSpriteName(rawName: string): string | null {
  const cached = nameCache.get(rawName);
  if (cached !== undefined) return cached;
  let name: string | null = null;
  if (SPRITE_MANIFEST[rawName]) name = rawName;
  else if (SPRITE_ALIASES[rawName] && SPRITE_MANIFEST[SPRITE_ALIASES[rawName]]) {
    name = SPRITE_ALIASES[rawName];
  } else {
    for (const suffix of STATE_SUFFIXES) {
      if (rawName.length > suffix.length && rawName.endsWith(suffix)) {
        const base = rawName.slice(0, -suffix.length);
        if (SPRITE_MANIFEST[base]) {
          name = base;
          break;
        }
      }
    }
  }
  nameCache.set(rawName, name);
  return name;
}

/**
 * URL of the pre-rendered 128 px roster icon for a sheet name — the
 * SAME 3D model the map draws, framed as a thumbnail. One file per
 * (sheet, colour), so a DOM list can use a plain ``<img>`` and never
 * touch this module's per-frame atlas state (``beginSpriteFrame``),
 * which the 60 fps canvas loop owns exclusively.
 *
 * ``name`` must already be canonical — pass it through
 * ``canonicalSpriteName`` first.
 */
export function spriteIconUrl(name: string, color: SpriteColor): string {
  return `${SPRITE_BASE}/icons/${name}_${color}.webp`;
}

/**
 * How much of the icon frame the drawn pixels should span after
 * correction. Slightly under 1 so a corrected structure keeps a hair of
 * breathing room inside the chip — the same framing the units already
 * shipped with (Marine measures 0.984).
 */
const ICON_FIT_TARGET = 0.92;

/**
 * Ceiling on the correction. The genuinely tiny models — Larva,
 * Changeling, Locust — measure around 0.47, and scaling those all the
 * way to the target would draw a Larva as large as a Thor and push the
 * frame's overflow well outside the chip's layout box. Capping keeps a
 * residual size hierarchy and bounds the overdraw at 35 %.
 */
const ICON_FIT_MAX = 1.35;

/**
 * CSS scale that makes a roster icon's drawn pixels fill its box.
 *
 * The Blender bake framed every model independently and did NOT
 * normalise the result: units run edge to edge (Marine 0.984, Thor
 * 1.0) while structures kept a wide transparent margin (Nexus 0.672,
 * Dark Shrine 0.578). In a 22 px chip that margin costs the Nexus a
 * third of its pixels, and it reads as a mis-sized icon beside a
 * full-bleed Marine rather than as a smaller building — nothing in the
 * framing encodes real in-game scale, so there is no meaning to
 * preserve.
 *
 * ``name`` must already be canonical — pass it through
 * ``canonicalSpriteName`` first. Unknown names (and anything already at
 * or above the target) return 1, so a sprite added ahead of the next
 * ``gen-sprite-icon-fit`` run simply goes uncorrected.
 *
 * Apply it as a transform rather than as width/height: the element
 * keeps its layout size and only the transparent margin spills outside
 * it, so a denser row does not reflow.
 */
export function spriteIconScale(name: string | null | undefined): number {
  if (!name) return 1;
  const fill = SPRITE_ICON_FILL[name];
  if (!fill || fill >= ICON_FIT_TARGET) return 1;
  return Math.min(ICON_FIT_TARGET / fill, ICON_FIT_MAX);
}

/**
 * Playback unit/building name → sheet, or null when no sheet ships for
 * it (Broodling and the Adept phase-shift have no extractable model;
 * rarely-seen campaign units have none either). Callers fall back to
 * the flat icon.
 *
 * ``kind`` guards against a unit name resolving onto a building sheet
 * or vice versa — the payload always knows which list it came from.
 */
export function resolveSprite(
  rawName: string,
  kind: "unit" | "building",
): ResolvedSprite | null {
  const key = `${kind}:${rawName}`;
  const cached = resolveCache.get(key);
  if (cached !== undefined) return cached;
  let resolved: ResolvedSprite | null = null;
  const name = canonicalSpriteName(rawName);
  if (name) {
    const meta = SPRITE_MANIFEST[name];
    if (meta.kind === kind || DUAL_KIND_SPRITES.has(name)) {
      resolved = { name, meta, handles: {} };
    }
  }
  resolveCache.set(key, resolved);
  return resolved;
}

/**
 * The anim to play, falling back to Stand when the requested cycle
 * doesn't exist (``noWalkSequence``: Carrier, SiegeTank and Tempest
 * genuinely have no walk cycle, and no building does). The handle is
 * memoized on the sprite, so this is a property lookup after the first
 * call — safe to call per unit per frame.
 */
export function spriteAnim(sprite: ResolvedSprite, want: string): SpriteAnimHandle {
  const cached = sprite.handles[want];
  if (cached) return cached;
  const name = sprite.meta.anims[want] ? want : "Stand";
  const anim = sprite.meta.anims[name];
  const handle: SpriteAnimHandle = {
    sprite,
    name,
    anim,
    redUrl: spriteUrl(sprite.meta.kind, sprite.meta.race, sprite.name, "red", anim.suffix),
    blueUrl: spriteUrl(sprite.meta.kind, sprite.meta.race, sprite.name, "blue", anim.suffix),
  };
  sprite.handles[want] = handle;
  // Stand is its own fallback, so cache it under both keys when the
  // requested anim doesn't exist.
  if (name !== want) sprite.handles[name] = handle;
  return handle;
}

/** Does this sprite have a real walk cycle? */
export function hasWalk(sprite: ResolvedSprite): boolean {
  return sprite.meta.anims.Walk !== undefined;
}

/* ──────────────── sheet decoding ──────────────── */

type Decoded = ImageBitmap | HTMLImageElement;

interface SheetEntry {
  image: Decoded | null;
  /** ``true`` once the fetch settled — failed sheets are never retried
   * (a missing sheet is permanent, and retrying it every frame would
   * hammer the CDN). */
  failed: boolean;
}

const sheetCache = new Map<string, SheetEntry>();

/**
 * Bumped whenever a sheet or atlas finishes loading. The replayer's
 * draw loop folds this into its dirty flag, so a PAUSED replay still
 * picks up late-decoding art without re-rendering every frame.
 */
let version = 0;

export function spriteAssetsVersion(): number {
  return version;
}

function ensureSheet(url: string): Decoded | null {
  const hit = sheetCache.get(url);
  if (hit) return hit.image;
  if (typeof Image === "undefined") return null; // non-DOM test envs
  const entry: SheetEntry = { image: null, failed: false };
  sheetCache.set(url, entry);
  const img = new Image();
  // REQUIRED, not optional: cells are re-rasterised into an offscreen
  // canvas, so a tainted sheet would taint every atlas and then the
  // main canvas, killing any future screenshot/clip export.
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.onload = () => {
    // An ImageBitmap is a decoded, GPU-resident surface: blitting from
    // it skips the per-draw decode check an HTMLImageElement carries.
    if (typeof createImageBitmap === "function") {
      createImageBitmap(img).then(
        (bmp) => {
          entry.image = bmp;
          version += 1;
        },
        () => {
          entry.image = img; // still perfectly drawable
          version += 1;
        },
      );
    } else {
      entry.image = img;
      version += 1;
    }
  };
  img.onerror = () => {
    entry.failed = true;
    version += 1;
  };
  img.src = url;
  return null;
}

/* ──────────────── size-bucket atlases ──────────────── */

/** Smallest atlas cell worth building. Below this a unit is a few
 * pixels and the bucket above costs nothing. */
const MIN_BUCKET_PX = 8;
/**
 * Largest atlas cell. The atlas exists to make heavy DOWNSCALES cheap
 * and clean; at 64 px per cell the shrink from a 256/512 px source is
 * only 4:1–8:1, and one 8×8 unit atlas already costs 1 MB. Above this
 * the draw path blits the source cell directly — which at that zoom
 * is both sharper and rarer (culling leaves few units on screen).
 * Without the cap, an 8× zoom would ask for a 256 px bucket and build
 * a 16 MB atlas per sheet.
 */
const MAX_BUCKET_PX = 64;
/** Total decoded atlas bytes kept alive. Beyond it the least recently
 * drawn atlas is dropped; it rebuilds on demand if it comes back. */
const ATLAS_BYTE_BUDGET = 48 * 1024 * 1024;
/** Atlases built per rendered frame. A 2048² sheet rescale is a few
 * ms; spreading them keeps a battle's worth of new unit types from
 * stalling one frame. */
const ATLAS_BUILDS_PER_FRAME = 2;

interface Atlas {
  canvas: HTMLCanvasElement;
  /** Cell size in this atlas, in device px. */
  cell: number;
  bytes: number;
  /** Frame stamp for LRU. */
  used: number;
}

const atlasCache = new Map<string, Atlas>();
let atlasBytes = 0;
let frameStamp = 0;
let buildsThisFrame = 0;
/** Device px per scene px for the current frame: view zoom × dpr. */
let rasterScale = 1;

/**
 * Call once per rendered frame, before any ``drawSprite``. ``scale`` is
 * device px per scene px (the view zoom times devicePixelRatio) — it
 * decides which size bucket the sprites rasterise into.
 */
export function beginSpriteFrame(scale: number): void {
  frameStamp += 1;
  buildsThisFrame = 0;
  rasterScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Power-of-two bucket at or above the on-screen cell size. Returns 0
 * when the request is past ``MAX_BUCKET_PX`` (or the source cell size)
 * — the caller then blits the sheet directly. Powers of two keep the
 * source:bucket ratio an exact power of two, which is what makes the
 * downscale a chain of clean 2:1 halvings. */
function bucketFor(devicePx: number, frameSize: number): number {
  const want = Math.max(MIN_BUCKET_PX, devicePx);
  const pow = 1 << Math.ceil(Math.log2(want));
  if (pow > MAX_BUCKET_PX || pow >= frameSize) return 0;
  return Math.max(MIN_BUCKET_PX, pow);
}

let scratchA: HTMLCanvasElement | null = null;
let scratchB: HTMLCanvasElement | null = null;

function scratch(which: 0 | 1, w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  let c = which === 0 ? scratchA : scratchB;
  if (!c) {
    c = document.createElement("canvas");
    if (which === 0) scratchA = c;
    else scratchB = c;
  }
  if (c.width < w || c.height < h) {
    c.width = Math.max(c.width, w);
    c.height = Math.max(c.height, h);
  }
  return c;
}

function evictAtlases(): void {
  if (atlasBytes <= ATLAS_BYTE_BUDGET) return;
  const entries = [...atlasCache.entries()].sort((a, b) => a[1].used - b[1].used);
  for (const [key, atlas] of entries) {
    if (atlasBytes <= ATLAS_BYTE_BUDGET) break;
    atlasCache.delete(key);
    atlasBytes -= atlas.bytes;
    // Release the backing store promptly rather than waiting for GC.
    atlas.canvas.width = 0;
    atlas.canvas.height = 0;
  }
}

/**
 * Pre-scale the whole grid to ``bucket`` px per cell. The source cell
 * size and the bucket are both powers of two, so the ratio is an exact
 * power of two and the downscale is a chain of 2:1 halvings — each one
 * a clean 4-texel box average, with none of the aliasing a single
 * bilinear 16:1 shrink produces.
 */
function buildAtlas(
  key: string,
  image: Decoded,
  meta: SpriteSheetMeta,
  anim: SpriteAnimMeta,
  bucket: number,
): Atlas | null {
  if (typeof document === "undefined") return null;
  const outW = anim.cols * bucket;
  const outH = anim.rows * bucket;
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  let srcW = anim.cols * meta.frameSize;
  let srcH = anim.rows * meta.frameSize;
  let src: CanvasImageSource = image;
  let pass = 0;
  // Halve until one more halving would undershoot the target.
  while (srcW >= outW * 2 && srcH >= outH * 2 && srcW > 1 && srcH > 1) {
    const nw = srcW >> 1;
    const nh = srcH >> 1;
    const dst = scratch((pass % 2) as 0 | 1, nw, nh);
    const dctx = dst?.getContext("2d");
    if (!dst || !dctx) break;
    dctx.imageSmoothingEnabled = true;
    dctx.imageSmoothingQuality = "high";
    dctx.clearRect(0, 0, nw, nh);
    dctx.drawImage(src, 0, 0, srcW, srcH, 0, 0, nw, nh);
    src = dst;
    srcW = nw;
    srcH = nh;
    pass += 1;
  }
  ctx.drawImage(src, 0, 0, srcW, srcH, 0, 0, outW, outH);
  const atlas: Atlas = { canvas, cell: bucket, bytes: outW * outH * 4, used: frameStamp };
  atlasCache.set(key, atlas);
  atlasBytes += atlas.bytes;
  evictAtlases();
  return atlas;
}

/** Best atlas available RIGHT NOW for this sheet at this bucket:
 * the exact bucket, else the closest already-built one (preferring a
 * larger, i.e. sharper, atlas), else null. Never blocks a frame on a
 * build it has no budget for. */
function atlasFor(
  url: string,
  image: Decoded,
  meta: SpriteSheetMeta,
  anim: SpriteAnimMeta,
  bucket: number,
): Atlas | null {
  const key = `${url}|${bucket}`;
  const exact = atlasCache.get(key);
  if (exact) {
    exact.used = frameStamp;
    return exact;
  }
  if (buildsThisFrame < ATLAS_BUILDS_PER_FRAME) {
    buildsThisFrame += 1;
    const built = buildAtlas(key, image, meta, anim, bucket);
    if (built) return built;
  }
  // Fall back to any cached size for this sheet so the unit still
  // draws (slightly soft or slightly oversampled) this frame.
  let best: Atlas | null = null;
  const prefix = `${url}|`;
  for (const [k, atlas] of atlasCache) {
    if (!k.startsWith(prefix)) continue;
    if (!best || Math.abs(atlas.cell - bucket) < Math.abs(best.cell - bucket)) {
      best = atlas;
    }
  }
  if (best) best.used = frameStamp;
  return best;
}

/* ──────────────── draw ──────────────── */

/** The scene-space rect ``drawSprite`` blits into, and where the CELL's
 * own centre lands. Anchored draws put the model's GROUND ORIGIN on
 * ``(x, y)``, so ``cx``/``cy`` — the middle of the bitmap — sits above
 * it by ``(frameSize / 2 − ay) × cellPx / frameSize``. Exported so the
 * placement of an anchored sprite can be measured against map furniture
 * that is drawn centred (the resource glyphs) without a canvas. */
export interface SpriteDrawRect {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly cx: number;
  readonly cy: number;
}

export function spriteDrawRect(
  handle: SpriteAnimHandle,
  x: number,
  y: number,
  cellPx: number,
): SpriteDrawRect {
  const scale = cellPx / handle.sprite.meta.frameSize;
  const dx = x - handle.anim.ax * scale;
  const dy = y - handle.anim.ay * scale;
  return { x: dx, y: dy, size: cellPx, cx: dx + cellPx / 2, cy: dy + cellPx / 2 };
}

/**
 * Draw one sprite cell so that its ANCHOR pixel lands on ``(x, y)`` in
 * scene coordinates, ``cellPx`` scene px wide.
 *
 * The cell is drawn square. The sheets are orthographic renders from a
 * camera pitched 60° above the horizon, so one cell pixel is
 * ``wupc / frameSize`` world units in BOTH image-plane axes — the
 * sprite must not be squashed to "correct" for the pitch (see
 * NOTES.md: the map is top-down, the sprites stand upright on it).
 *
 * Returns false when the sheet is not decoded yet (or missing), so the
 * caller can fall back to the flat icon for this frame.
 */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  handle: SpriteAnimHandle,
  color: SpriteColor,
  facing: number,
  frame: number,
  x: number,
  y: number,
  cellPx: number,
): boolean {
  const meta = handle.sprite.meta;
  const anim = handle.anim;
  const url = color === "red" ? handle.redUrl : handle.blueUrl;
  const image = ensureSheet(url);
  if (!image) return false;

  // Buildings have a single facing and must never be rotated.
  const f = meta.facings > 1 ? ((facing % meta.facings) + meta.facings) % meta.facings : 0;
  const fr = frame < 0 ? 0 : frame >= anim.frames ? anim.frames - 1 : frame;
  const cellIndex = f * anim.cols + fr;
  const col = cellIndex % anim.cols;
  const row = (cellIndex / anim.cols) | 0;

  const rect = spriteDrawRect(handle, x, y, cellPx);
  const dx = rect.x;
  const dy = rect.y;

  const bucket = bucketFor(cellPx * rasterScale, meta.frameSize);
  if (bucket > 0) {
    const atlas = atlasFor(url, image, meta, anim, bucket);
    if (atlas) {
      const s = atlas.cell;
      ctx.drawImage(atlas.canvas, col * s, row * s, s, s, dx, dy, cellPx, cellPx);
      return true;
    }
  }
  // Zoomed in far enough that an atlas would be a near-copy of the
  // sheet (or the atlas budget is spent and nothing is cached yet):
  // blit the source cell directly.
  const fs = meta.frameSize;
  ctx.drawImage(image, col * fs, row * fs, fs, fs, dx, dy, cellPx, cellPx);
  return true;
}

/** Test/diagnostic hook: how much decoded atlas memory is live. */
export function spriteAtlasStats(): { atlases: number; bytes: number; sheets: number } {
  return { atlases: atlasCache.size, bytes: atlasBytes, sheets: sheetCache.size };
}
