import type { ReplayCanvas, ReplayCanvasContext } from "@/lib/replayCanvas";
import { buildingVisibleAt, buildingPositionAt, gasTappedAt, isWorkerUnit, resourceAliveAt, projectX, projectY, unitNameAt, unitVisibleAt, unitMaxSpeed, worldProjection, type MapPlayback } from "@/lib/mapReplay";
import { animFrameIndex, motionSample, sampleTrack, type MotionSample } from "@/lib/replayMotion";
import { beginSpriteFrame, drawSprite, endSpriteFrame, hasWalk, resolveSprite, spriteAnim, type SpriteAnimHandle, type SpriteColor } from "@/lib/spriteSheets";

import type { PatchEra } from "@/lib/meta";
import { drawSpellEffects } from "@/lib/spellEffects";
import { drawEstimatedCreep } from "@/lib/replayCreep";
import { drawObservedCreep } from "@/lib/replayObservedCreep";
import { attackAt, attackFrame, drawWeaponEffects, unitFacingAt } from "@/lib/replayCombat";

import { type IconKind } from "@/lib/sc2-icons";

import { replayCameraAt, type ReplayCameraMode } from "@/lib/replayCamera";
import { drawMarkers, type ReplayMapMarker } from "@/lib/replayMarkers";
import { buildingFirstSeen, VISION_EDGE, VisionGrid, visionViewer, type ReplayVision, type SightRadii } from "@/lib/replayVision";
import { pushHit, type ReplayEntityRef, type ReplayHitBuffer } from "@/lib/replayInspect";

import { ME_ARMY, ME_WORKER, OPP_ARMY, OPP_WORKER, ME_SHEET, OPP_SHEET, BATTLE_WINDOW_SEC, RESOURCE_GLYPH_WORLD, ROCKS_GLYPH_WORLD, SPAWN_RING_WORLD, BATTLE_RING_MIN_WORLD, BATTLE_RING_GROW_WORLD, MIN_FURNITURE_SCREEN_PX, STAGE_PAD_PX, SPRITE_WORLD_GAIN, MIN_SPRITE_SCREEN_PX, FALLBACK_UNIT_WORLD, FALLBACK_WORKER_WORLD, FALLBACK_BUILDING_WORLD, WALK_SPEED_THRESHOLD, FOG_ALPHA, SIGHT_UNIT, SIGHT_WORKER, SIGHT_HALL, SIGHT_BUILDING, FOG_RENDER_SCALE, FOG_MAX_DPR, CULL_MARGIN_WORLD, FOG_DEDUPE_RADIUS_FRACTION, VIGNETTE_ALPHA, VIGNETTE_INNER, iconToken, resourceGlyph, derivedOf, fogMask, ViewTransform } from "./mapCanvasAssets";

/** One fog buffer per target canvas: the live stage and an off-screen
 * clip render alternate frames, and sharing one buffer would resize
 * (and reallocate) it on every call. */
const fogCanvases = new WeakMap<ReplayCanvas, HTMLCanvasElement>();

/** "Last seen" enemy structures draw at this opacity in single-side vision. */
const GHOST_ALPHA = 0.4;
const SIGHT: SightRadii = { unit: SIGHT_UNIT, worker: SIGHT_WORKER, hall: SIGHT_HALL, building: SIGHT_BUILDING };
/** Reused every frame; only single-side vision touches it. */
const visionGrid = new VisionGrid();

interface DrawEntity {
  side: "me" | "opp";
  x: number;
  y: number;
  cellPx: number;
  handle: SpriteAnimHandle | null;
  color: SpriteColor;
  facing: number;
  frame: number;
  /** Fallback icon path data when ``handle`` is null. */
  name: string;
  iconKind: IconKind;
  tint: string;
  dot: string;
  alpha: number;
  worker: boolean;
  /** World position, for the one vision lookup per enemy entity. */
  wx: number;
  wy: number;
  /** Index into ``playback.units`` or ``playback.buildings``. */
  index: number;
  /** A remembered enemy structure outside current sight. */
  ghost: boolean;
}

const entityPool: DrawEntity[] = [];
let entityCount = 0;
const drawOrder: number[] = [];

function pushEntity(): DrawEntity {
  let e = entityPool[entityCount];
  if (!e) {
    e = {
      side: "me", x: 0, y: 0, cellPx: 0, handle: null, color: "red", facing: 0, frame: 0,
      name: "", iconKind: "unit", tint: "", dot: "", alpha: 1, worker: false, wx: 0, wy: 0, index: 0, ghost: false,
    };
    entityPool[entityCount] = e;
  }
  entityCount += 1;
  return e;
}

/** Scratch motion samples — module-level so the hot loop allocates
 * nothing per unit per frame. */
const trackSample: MotionSample = motionSample();

/** Fog reveal sources, pooled the same way as the entity list. */
const fogX: number[] = [];
const fogY: number[] = [];
const fogR: number[] = [];
let fogCount = 0;

function pushFog(x: number, y: number, r: number): void {
  fogX[fogCount] = x;
  fogY[fogCount] = y;
  fogR[fogCount] = r;
  fogCount += 1;
}

export type MapFrameStyle = { entities: "dots"; palette?: { me?: string; opp?: string } };

export interface RenderFrameOptions {
  /** Whose sight reveals the map (lib/replayVision); default both. */
  vision?: ReplayVision;
  /** Device pixels per CSS pixel of THIS canvas. Defaults to the
   *  window's; an off-screen clip render draws 1:1. */
  dpr?: number;
  /** Filled with every live entity drawn, in canvas CSS px, for taps. */
  hits?: ReplayHitBuffer | null;
  /** Ringed so the inspected or followed unit stands out. */
  selected?: ReplayEntityRef | null;
  camera?: ReplayCameraMode;
}

export function renderFrame(
  ctx: ReplayCanvasContext,
  canvas: ReplayCanvas,
  playback: MapPlayback,
  t: number,
  layout: HTMLImageElement | null,
  view: ViewTransform,
  markers?: readonly ReplayMapMarker[],
  style?: MapFrameStyle,
  options?: RenderFrameOptions,
) {
  const dots = style?.entities === "dots";
  const dpr = options?.dpr ?? (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  const { bounds } = playback;

  /* ── THE transform ──────────────────────────────────────────────
   * ``worldProjection`` is the single authority for world → canvas.
   * ``k`` is PIXELS PER WORLD UNIT; every length on screen derives
   * from it — terrain rect, sprite cell width, effect and fog
   * radii. Nothing in this file may size anything in
   * raw pixels that represents a world quantity.
   *
   *   canvasX = proj.ox + (worldX - bounds.minX) * k
   *   canvasY = proj.oy + (bounds.maxY - worldY) * k      (Y flipped)
   *   spriteCellPx = worldUnitsPerCell * k
   */
  const proj = worldProjection(bounds, w, h, STAGE_PAD_PX);
  const k = proj.k;

  // Device px per scene px this frame: the view zoom times the device
  // pixel ratio. Sprite atlases and icon tokens rasterise against it,
  // so they stay crisp under zoom instead of magnifying a 1× raster.
  const rasterScale = view.z * dpr;
  // Icon tokens keep the old power-of-two quantisation so their cache
  // stays tiny (≤3 sizes); sprite atlases bucket internally.
  const iconDpr = dpr * Math.min(4, Math.pow(2, Math.ceil(Math.log2(Math.max(1, view.z)))));
  if (!dots) beginSpriteFrame(rasterScale);

  // Visible scene rect, for culling. A scene point p is drawn at
  // ox + p*z, so the visible range is [-ox/z, (w-ox)/z].
  const cullX0 = -view.ox / view.z;
  const cullY0 = -view.oy / view.z;
  const cullX1 = cullX0 + w / view.z;
  const cullY1 = cullY0 + h / view.z;

  ctx.clearRect(0, 0, w, h);
  // Zoom/pan: scale the whole scene (sprites included — true zoom).
  ctx.save();
  ctx.translate(view.ox, view.oy);
  ctx.scale(view.z, view.z);

  // Real map layout under everything, at FULL COLOUR, stretched to the
  // projected playable rect — the same rect every sprite projects into,
  // so terrain and unit positions share one coordinate mapping. The
  // old flat dark veil is gone; contrast comes from the edge vignette
  // drawn at the very end instead.
  const rectW = (bounds.maxX - bounds.minX) * k;
  const rectH = (bounds.maxY - bounds.minY) * k;
  if (layout) {
    ctx.drawImage(layout, proj.ox, proj.oy, rectW, rectH);
  }

  // Neutral terrain furniture (v2 payloads): mineral lines, geysers,
  // rocks, towers — mined-out patches and broken rocks disappear at
  // their recorded death time.
  const derived = derivedOf(playback);
  if (playback.creep) drawObservedCreep(ctx, bounds, proj, playback.creep, t);
  else drawEstimatedCreep(ctx, bounds, proj, derived.creepSources, t);
  const minFurniturePx = MIN_FURNITURE_SCREEN_PX / view.z;
  const glyphPx = Math.max(minFurniturePx, RESOURCE_GLYPH_WORLD * k);
  const rocksPx = Math.max(minFurniturePx, ROCKS_GLYPH_WORLD * k);
  for (const r of playback.resources) {
    if (!resourceAliveAt(r, t)) continue;
    // A TAPPED geyser is not drawn at all: the structure standing on it
    // IS its presentation, exactly as in SC2, where a built
    // Refinery/Extractor/Assimilator hides the geyser completely.
    //
    // This is the gas-placement fix. The two are recorded at the same
    // map coordinate (measured: Δ = 0 on every gas structure in ten
    // real payloads), but they are PLACED by different conventions —
    // the glyph is centred on the coordinate, while the sprite is
    // anchored at its model's ground origin, which sits below the
    // bitmap's centre. The sprite's cell therefore lands ~0.5–0.7 world
    // units up-screen of the glyph (see the harness in
    // ``lib/__tests__/gasPlacement.test.ts``), and the green pool fringed
    // out from under the structure's downhill edge — most visibly in
    // the compact host, where ``MIN_FURNITURE_SCREEN_PX`` floors the
    // glyph at 9 px while an Assimilator is only 9.8 px wide.
    //
    // The anchor convention is not the thing to change: it is what puts
    // every unit's feet and every structure's footprint on its
    // coordinate. Removing the duplicate marker is.
    if (r.kind === "gas" && gasTappedAt(derived.gasBuildings, r, t)) continue;
    const glyph = resourceGlyph(r.kind, iconDpr);
    if (!glyph) continue;
    const size = r.kind === "rocks" ? rocksPx : glyphPx;
    ctx.drawImage(
      glyph,
      projectX(bounds, proj, r.x) - size / 2,
      projectY(bounds, proj, r.y) - size / 2,
      size,
      size,
    );
  }

  const trackBox = derived.trackBox;
  entityCount = 0;
  fogCount = 0;
  // Single-side vision: only the viewer's units and structures push fog
  // and stamp the world-space sight grid that hides everything else.
  const viewer = visionViewer(options?.vision);
  const fogOff = options?.vision === "off";
  if (viewer) visionGrid.reset(bounds);

  // Margin for the cheap track-bbox reject, in canvas px — see
  // CULL_MARGIN_WORLD for what it has to cover.
  const pad = CULL_MARGIN_WORLD * k;
  // A sprite's on-screen floor, expressed in scene px so the ctx zoom
  // turns it back into a constant screen size.
  const minCellScenePx = MIN_SPRITE_SCREEN_PX / view.z;

  /* ── Units ─────────────────────────────────────────────────────── */
  const units = playback.units;
  for (let idx = 0; idx < units.length; idx += 1) {
    const u = units[idx];
    if (!unitVisibleAt(u, t)) continue;
    // Cheap reject: a unit whose whole track sits off screen can never
    // be visible, so skip the interpolation entirely.
    const bx0 = trackBox[idx * 4];
    if (bx0 !== Infinity) {
      const sx0 = projectX(bounds, proj, bx0) - pad;
      const sx1 = projectX(bounds, proj, trackBox[idx * 4 + 2]) + pad;
      // Y is flipped by the projection, so maxY maps to the smaller
      // canvas coordinate.
      const sy0 = projectY(bounds, proj, trackBox[idx * 4 + 3]) - pad;
      const sy1 = projectY(bounds, proj, trackBox[idx * 4 + 1]) + pad;
      if (sx1 < cullX0 || sx0 > cullX1 || sy1 < cullY0 || sy0 > cullY1) continue;
    }

    const name = unitNameAt(u, t);
    const pos = sampleTrack(u.wp, t, unitMaxSpeed(name, playback.fidelity?.positions === "engine"), trackSample);
    if (!pos) continue;
    const { x: wx, y: wy, vx, vy } = pos;
    const worker = isWorkerUnit(name);

    const sx = projectX(bounds, proj, wx);
    const sy = projectY(bounds, proj, wy);
    if (!fogOff && (!viewer || u.owner === viewer)) {
      const sight = worker ? SIGHT_WORKER : SIGHT_UNIT;
      pushFog(sx, sy, sight);
      if (viewer) visionGrid.stamp(wx, wy, sight * VISION_EDGE);
    }

    // Actual weapon cycles trigger a single Attack clip. Otherwise use
    // observed movement to choose Walk or Stand.
    const walking = vx * vx + vy * vy > WALK_SPEED_THRESHOLD * WALK_SPEED_THRESHOLD;
    const formSprite = name !== u.name ? resolveSprite(name, "unit") : null;
    const sprite = name !== u.name ? formSprite : derived.unitStand[idx]?.sprite;
    const attackHandle = sprite?.meta.anims.Attack ? spriteAnim(sprite, "Attack") : null;
    const attack = attackAt(u, t, attackHandle ? Math.min(1, attackHandle.anim.frames / attackHandle.anim.fps) : 0.6);
    const handle = attack && attackHandle ? attackHandle : name !== u.name
      ? formSprite ? spriteAnim(formSprite, walking && hasWalk(formSprite) ? "Walk" : "Stand") : null
      : walking ? derived.unitWalk[idx] : derived.unitStand[idx];
    let cellPx = handle
      ? handle.anim.wupc * k * SPRITE_WORLD_GAIN
      : (worker ? FALLBACK_WORKER_WORLD : FALLBACK_UNIT_WORLD) * k;
    if (cellPx < minCellScenePx) cellPx = minCellScenePx;

    if (sx + cellPx < cullX0 || sx - cellPx > cullX1) continue;
    if (sy + cellPx < cullY0 || sy - cellPx > cullY1) continue;

    const facing = unitFacingAt(u, t, pos, attack);

    const e = pushEntity();
    e.side = u.owner;
    e.x = sx;
    e.y = sy;
    e.cellPx = cellPx;
    e.handle = handle;
    e.color = u.owner === "me" ? ME_SHEET : OPP_SHEET;
    e.facing = facing;
    e.frame = handle
      ? attack && handle === attackHandle ? attackFrame(attack.age, handle.anim.fps, handle.anim.frames)
        : animFrameIndex(t, handle.anim.fps, handle.anim.frames, derived.phase[idx])
      : 0;
    e.name = name;
    e.iconKind = "unit";
    e.tint = u.owner === "me" ? ME_ARMY : OPP_ARMY;
    e.dot = u.owner === "me" ? (worker ? ME_WORKER : ME_ARMY) : worker ? OPP_WORKER : OPP_ARMY;
    e.alpha = handle ? 1 : worker ? 0.75 : 1;
    e.worker = worker;
    e.wx = wx;
    e.wy = wy;
    e.index = idx;
    e.ghost = false;
  }

  /* ── Buildings ─────────────────────────────────────────────────── */
  const buildings = playback.buildings;
  for (let bi = 0; bi < buildings.length; bi += 1) {
    const b = buildings[bi];
    if (!buildingVisibleAt(b, t)) continue;
    const bpos = buildingPositionAt(b, t, playback.fidelity?.positions === "engine");
    const sx = projectX(bounds, proj, bpos.x);
    const sy = projectY(bounds, proj, bpos.y);
    if (!fogOff && (!viewer || b.owner === viewer)) {
      const sight = derived.buildingHall[bi] === 1 ? SIGHT_HALL : SIGHT_BUILDING;
      pushFog(sx, sy, sight);
      if (viewer) visionGrid.stamp(bpos.x, bpos.y, sight * VISION_EDGE);
    }

    // Buildings have facings: 1 — they never rotate — and their draw
    // size comes from the same worldUnitsPerCell ladder as units, so
    // the old hard-coded town-hall size bump is gone.
    const name = unitNameAt(b, t);
    const formSprite = name !== b.name ? resolveSprite(name, "building") : null;
    const sprite = name !== b.name ? formSprite : derived.buildingStand[bi]?.sprite;
    const attackHandle = sprite?.meta.anims.Attack ? spriteAnim(sprite, "Attack") : null;
    const attack = attackAt(b, t, attackHandle ? Math.min(1, attackHandle.anim.frames / attackHandle.anim.fps) : 0.6);
    const handle = attack && attackHandle ? attackHandle : name !== b.name ? formSprite ? spriteAnim(formSprite, "Stand") : null : derived.buildingStand[bi];
    let cellPx = handle
      ? handle.anim.wupc * k * SPRITE_WORLD_GAIN
      : FALLBACK_BUILDING_WORLD * k;
    if (cellPx < minCellScenePx) cellPx = minCellScenePx;
    if (sx + cellPx < cullX0 || sx - cellPx > cullX1) continue;
    if (sy + cellPx < cullY0 || sy - cellPx > cullY1) continue;

    const e = pushEntity();
    e.side = b.owner;
    e.x = sx;
    e.y = sy;
    e.cellPx = cellPx;
    e.handle = handle;
    e.color = b.owner === "me" ? ME_SHEET : OPP_SHEET;
    e.facing = 0;
    e.frame = handle
      ? attack && handle === attackHandle ? attackFrame(attack.age, handle.anim.fps, handle.anim.frames)
        : animFrameIndex(t, handle.anim.fps, handle.anim.frames, derived.buildingPhase[bi])
      : 0;
    e.name = name;
    e.iconKind = "building";
    e.tint = b.owner === "me" ? ME_ARMY : OPP_ARMY;
    e.dot = b.owner === "me" ? "rgba(62,192,199,0.75)" : "rgba(224,86,86,0.75)";
    e.alpha = 1;
    e.worker = false;
    e.wx = bpos.x;
    e.wy = bpos.y;
    e.index = bi;
    e.ghost = false;
  }

  if (viewer) hideUnseenEnemies(playback, viewer, t);
  recordHits(options?.hits, view);

  /* ── Fog of war ────────────────────────────────────────────────
   * Union of BOTH sides' vision (matching the replay viewer
   * convention) — a dark layer with soft reveals punched out around
   * every unit and standing building. Unscouted map stays dim. Drawn
   * over terrain but UNDER the entities, so units are never hidden.
   */
  // Single-side vision fogs the whole view even with no friendly source
  // in it; the default union keeps its old "no sources, no fog" rule.
  const mask = fogCount > 0 || viewer ? fogMask() : null;
  if (typeof document !== "undefined" && mask) {
    let fogCanvas = fogCanvases.get(canvas);
    if (!fogCanvas) {
      fogCanvas = document.createElement("canvas");
      fogCanvases.set(canvas, fogCanvas);
    }
    const fscale = Math.min(FOG_MAX_DPR, dpr) * FOG_RENDER_SCALE;
    const fw = Math.max(1, Math.round(w * fscale));
    const fh = Math.max(1, Math.round(h * fscale));
    if (fogCanvas.width !== fw || fogCanvas.height !== fh) {
      fogCanvas.width = fw;
      fogCanvas.height = fh;
    }
    const fg = fogCanvas.getContext("2d");
    if (fg) {
      // Fog is built in SCREEN space, not scene space: the reveals are
      // projected through the view transform so the mask stays at a
      // constant fraction of screen resolution at every zoom (a
      // scene-space fog blurs 8× when you zoom 8×) and off-screen
      // sources cost nothing.
      fg.setTransform(fscale, 0, 0, fscale, 0, 0);
      fg.clearRect(0, 0, w, h);
      fg.globalCompositeOperation = "source-over";
      fg.fillStyle = `rgba(3,6,11,${FOG_ALPHA})`;
      fg.fillRect(0, 0, w, h);
      fg.globalCompositeOperation = "destination-out";
      // Integer grid keys (12 bits per axis, biased for negatives)
      // avoid 600 template strings per frame.
      const seen = new Set<number>();
      const z = view.z;
      for (let i = 0; i < fogCount; i += 1) {
        const worldR = fogR[i];
        const r = worldR * k * z;
        const cx = fogX[i] * z + view.ox;
        const cy = fogY[i] * z + view.oy;
        if (cx + r < 0 || cx - r > w || cy + r < 0 || cy - r > h) continue;
        const cell = Math.max(6, r * FOG_DEDUPE_RADIUS_FRACTION);
        const gx = (Math.round(cx / cell) + 2048) & 0xfff;
        const gy = (Math.round(cy / cell) + 2048) & 0xfff;
        const key = (gx << 20) | (gy << 8) | (worldR & 0xff);
        if (seen.has(key)) continue;
        seen.add(key);
        fg.drawImage(mask, cx - r, cy - r, r * 2, r * 2);
      }
      // Composite in screen space too, then hand the transform back.
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.drawImage(fogCanvas, 0, 0, w, h);
      ctx.restore();
    }
  }

  // Spawn anchors — subtle rings labeled by side colour.
  const spawnR = Math.max(minFurniturePx, SPAWN_RING_WORLD * k);
  for (const s of playback.spawns) {
    ctx.beginPath();
    ctx.arc(projectX(bounds, proj, s.x), projectY(bounds, proj, s.y), spawnR, 0, Math.PI * 2);
    ctx.strokeStyle = s.owner === "me" ? "rgba(62,192,199,0.35)" : "rgba(224,86,86,0.35)";
    ctx.lineWidth = 1.5 / view.z;
    ctx.stroke();
  }

  // Enemy effects and shots outside the viewer's sight stay hidden too.
  const canSee = viewer
    ? (owner: "me" | "opp" | "neutral", x: number, y: number) => owner === viewer || owner === "neutral" || visionGrid.seen(x, y)
    : undefined;
  if (!dots) drawSpellEffects(ctx, playback, t, proj, view, w, h, "ground", canSee);

  /* ── Painter's pass ────────────────────────────────────────────
   * Back to front by ground-point Y. Sorting an index array keeps the
   * pooled entity records stable and allocates nothing after warmup.
   */
  drawOrder.length = entityCount;
  for (let i = 0; i < entityCount; i += 1) drawOrder[i] = i;
  drawOrder.sort((a, b) => entityPool[a].y - entityPool[b].y);

  let alpha = 1;
  for (let i = 0; i < entityCount; i += 1) {
    const e = entityPool[drawOrder[i]];
    if (dots) {
      const radius = Math.max(2.5 / view.z, Math.min(4 / view.z, e.cellPx * 0.18));
      const color = style.palette?.[e.side] || e.dot;
      ctx.beginPath();
      if (e.iconKind === "building") ctx.rect(e.x - radius, e.y - radius, radius * 2, radius * 2);
      else ctx.arc(e.x, e.y, radius, 0, Math.PI * 2);
      if (e.side === "me") { ctx.fillStyle = color; ctx.fill(); }
      else { ctx.strokeStyle = color; ctx.lineWidth = 1.8 / view.z; ctx.stroke(); }
      continue;
    }
    if (e.alpha !== alpha) {
      ctx.globalAlpha = e.alpha;
      alpha = e.alpha;
    }
    if (
      e.handle &&
      drawSprite(ctx, e.handle, e.color, e.facing, e.frame, e.x, e.y, e.cellPx)
    ) {
      continue;
    }
    // Retain the loaded model while its first attack atlas is decoding.
    if (e.handle?.name === "Attack") {
      const idle = spriteAnim(e.handle.sprite, "Stand");
      const idleSize = Math.max(minCellScenePx, idle.anim.wupc * k * SPRITE_WORLD_GAIN);
      if (drawSprite(ctx, idle, e.color, e.facing, animFrameIndex(t, idle.anim.fps, idle.anim.frames, 0), e.x, e.y, idleSize)) continue;
    }
    // No sheet for this name (or it hasn't decoded yet): the flat
    // team-tinted icon, then a bare dot.
    const size = e.cellPx;
    const token = iconToken(e.name, e.iconKind, e.tint, size, iconDpr);
    if (token) {
      ctx.drawImage(token, e.x - size / 2, e.y - size / 2, size, size);
    } else {
      ctx.beginPath();
      ctx.arc(e.x, e.y, Math.max(1.4, size * 0.18), 0, Math.PI * 2);
      ctx.fillStyle = e.dot;
      ctx.fill();
    }
  }
  if (alpha !== 1) ctx.globalAlpha = 1;
  if (!dots) endSpriteFrame();
  if (!dots && options?.selected) drawSelection(ctx, options.selected, view.z);

  if (!dots) { drawSpellEffects(ctx, playback, t, proj, view, w, h, "overlay", canSee); drawWeaponEffects(ctx, playback, t, proj, view, canSee); }

  // Battle pulses near their marker time — drawn last so the amber
  // ring reads over the sprites it is calling attention to.
  for (const m of playback.battles) {
    const d = Math.abs(m.t - t);
    if (d > BATTLE_WINDOW_SEC) continue;
    if (viewer && !visionGrid.seen(m.x, m.y)) continue;
    const f = 1 - d / BATTLE_WINDOW_SEC;
    ctx.beginPath();
    ctx.arc(
      projectX(bounds, proj, m.x),
      projectY(bounds, proj, m.y),
      Math.max(minFurniturePx, (BATTLE_RING_MIN_WORLD + BATTLE_RING_GROW_WORLD * f) * k),
      0,
      Math.PI * 2,
    );
    ctx.strokeStyle = `rgba(230,180,80,${0.15 + 0.5 * f})`;
    ctx.lineWidth = 2 / view.z;
    ctx.stroke();
  }

  drawOtherCamera(ctx, playback, t, options?.camera, proj, view.z);
  ctx.restore();

  // Edge vignette, OUTSIDE the view transform so it hugs the stage
  // rather than the map. This replaces the old global dark wash: the
  // terrain keeps its real colour, and only the border darkens enough
  // to separate the stage from the page.
  const vignette = vignetteFor(w, h, ctx);
  if (vignette) {
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }

  if (markers && markers.length) {
    drawMarkers(ctx, bounds, worldProjection(bounds, w, h, STAGE_PAD_PX), t, view, w, h, markers);
  }
}

/**
 * Single-side vision, after both entity loops have stamped the viewer's
 * sight: ONE grid lookup per enemy entity. Unseen units are dropped;
 * unseen structures the viewer scouted earlier stay as dimmed, frozen
 * "last seen" ghosts. Partitions the pooled list in place.
 */
function hideUnseenEnemies(playback: MapPlayback, viewer: "me" | "opp", t: number): void {
  const firstSeen = buildingFirstSeen(playback, viewer, SIGHT);
  let kept = 0;
  for (let i = 0; i < entityCount; i += 1) {
    const e = entityPool[i];
    if (e.side !== viewer && !visionGrid.seen(e.wx, e.wy)) {
      if (e.iconKind !== "building" || !(firstSeen[e.index] <= t)) continue;
      e.ghost = true;
      e.alpha = GHOST_ALPHA;
      e.frame = 0;
    }
    if (kept !== i) {
      entityPool[i] = entityPool[kept];
      entityPool[kept] = e;
    }
    kept += 1;
  }
  entityCount = kept;
}

/** Live (non-ghost) entities in canvas CSS px, for click-to-inspect. */
function recordHits(hits: ReplayHitBuffer | null | undefined, view: ViewTransform): void {
  if (!hits) return;
  hits.count = 0;
  for (let i = 0; i < entityCount; i += 1) {
    const e = entityPool[i];
    if (e.ghost) continue;
    pushHit(hits, e.x * view.z + view.ox, e.y * view.z + view.oy, e.cellPx * view.z * 0.5,
      e.iconKind === "building" ? "building" : "unit", e.index);
  }
}

/** A thin ring around the inspected entity, drawn over the sprites. */
function drawSelection(ctx: ReplayCanvasContext, selected: ReplayEntityRef, z: number): void {
  for (let i = 0; i < entityCount; i += 1) {
    const e = entityPool[i];
    if (e.ghost || e.index !== selected.index || (e.iconKind === "building") !== (selected.kind === "building")) continue;
    ctx.beginPath();
    ctx.arc(e.x, e.y, Math.max(7 / z, e.cellPx * 0.55), 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = 2 / z;
    ctx.stroke();
    return;
  }
}

/** Cached vignette gradient, per context — rebuilt only when the
 * stage resizes, so the per-frame cost is one fillRect. */
const vignetteCache = new WeakMap<
  ReplayCanvasContext,
  { w: number; h: number; grad: CanvasGradient }
>();

function vignetteFor(
  w: number,
  h: number,
  ctx: ReplayCanvasContext,
): CanvasGradient | null {
  const hit = vignetteCache.get(ctx);
  if (hit && hit.w === w && hit.h === h) return hit.grad;
  if (!(w > 0 && h > 0)) return null;
  const cx = w / 2;
  const cy = h / 2;
  const outer = Math.hypot(cx, cy);
  const grad = ctx.createRadialGradient(cx, cy, outer * VIGNETTE_INNER, cx, cy, outer);
  grad.addColorStop(0, "rgba(6,9,14,0)");
  grad.addColorStop(1, `rgba(6,9,14,${VIGNETTE_ALPHA})`);
  vignetteCache.set(ctx, { w, h, grad });
  return grad;
}


function drawOtherCamera(
  ctx: CanvasRenderingContext2D, playback: MapPlayback, time: number,
  camera: ReplayCameraMode | undefined, proj: ReturnType<typeof worldProjection>, zoom: number,
) {
  if (!camera || camera === "free") return;
  const point = replayCameraAt(playback.camera?.[camera === "me" ? "opp" : "me"], time);
  if (!point) return;
  const x = projectX(playback.bounds, proj, point.x);
  const y = projectY(playback.bounds, proj, point.y);
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 1 / zoom;
  ctx.strokeRect(x - 12 * proj.k, y - 7 * proj.k, 24 * proj.k, 14 * proj.k);
}
