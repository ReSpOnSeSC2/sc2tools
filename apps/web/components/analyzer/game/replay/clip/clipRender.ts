/**
 * clipRender — one frame of a replay clip on an off-screen canvas.
 *
 * The map is drawn by the SAME ``renderFrame`` the live stage uses
 * (sprites, fog, the chosen vision, effects), at 1 device pixel per CSS
 * pixel, so a clip looks exactly like the player. On top go an optional
 * scoreboard band and the watermark. The scoreboard is deliberately
 * anonymous — races and team colours, never player names — because a
 * clip is made to be shared.
 */

import { getServerFormatter } from "@/lib/i18n/format";
import { statsAt, worldProjection, type MapPlayback } from "@/lib/mapReplay";
import { statsHaveWorkers, workerCountAt } from "@/lib/mapReplayLosses";
import { formatClock } from "@/lib/replayHud";
import { followView, type ReplayEntityRef, type ReplayView } from "@/lib/replayInspect";
import { visionIsObserved, visionViewer, type ReplayVision } from "@/lib/replayVision";
import { renderFrame } from "../mapCanvasRenderer";
import { ME_ARMY, OPP_ARMY, STAGE_PAD_PX } from "../mapCanvasAssets";
import { STAGE_BG } from "../replayTheme";

export interface ClipFrameOptions {
  playback: MapPlayback;
  layout: HTMLImageElement | null;
  vision: ReplayVision;
  hud: boolean;
  watermark: string;
  /** Anonymous side labels: races when known. */
  races: { me?: string | null; opp?: string | null };
  /** Camera for this frame; a follow updates it as the unit moves. */
  view: ReplayView;
  follow: ReplayEntityRef | null;
}

/**
 * Frame the clip like the on-screen map: the same world centre, zoomed
 * so everything visible on screen stays in shot on a canvas of another
 * shape. A whole-map screen view stays the whole map.
 */
export function clipCamera(
  playback: MapPlayback,
  screen: { view: ReplayView; width: number; height: number },
  width: number,
  height: number,
): ReplayView {
  const b = playback.bounds;
  const projS = worldProjection(b, screen.width, screen.height, STAGE_PAD_PX);
  const projC = worldProjection(b, width, height, STAGE_PAD_PX);
  if (!(projS.k > 0) || !(projC.k > 0) || !(screen.view.z > 1)) return { z: 1, ox: 0, oy: 0 };
  const { z, ox, oy } = screen.view;
  const worldX = b.minX + ((screen.width / 2 - ox) / z - projS.ox) / projS.k;
  const worldY = b.maxY - ((screen.height / 2 - oy) / z - projS.oy) / projS.k;
  const visibleW = screen.width / (z * projS.k);
  const visibleH = screen.height / (z * projS.k);
  const zc = Math.min(8, Math.max(1, Math.min(width / (visibleW * projC.k), height / (visibleH * projC.k))));
  const sx = projC.ox + (worldX - b.minX) * projC.k;
  const sy = projC.oy + (b.maxY - worldY) * projC.k;
  return {
    z: zc,
    ox: Math.min(0, Math.max(width - width * zc, width / 2 - sx * zc)),
    oy: Math.min(0, Math.max(height - height * zc, height / 2 - sy * zc)),
  };
}

/** Draw clip frame ``t`` onto ``canvas`` (whose 2D context is ``ctx``). */
export function renderClipFrame(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, t: number, options: ClipFrameOptions): void {
  const width = canvas.width;
  const height = canvas.height;
  if (options.follow) {
    const next = followView(options.playback, options.follow, t, options.view, width, height, STAGE_PAD_PX, options.view.z);
    if (next) options.view = next;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  renderFrame(ctx, canvas, options.playback, t, options.layout, options.view, undefined, undefined, { vision: options.vision, dpr: 1 });
  // Letterbox and unexplored corners read as the stage, not as black.
  ctx.save();
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = STAGE_BG;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
  const scale = Math.min(width / 1280, height / 720);
  if (options.hud) drawScoreboard(ctx, options, t, width, scale);
  drawWatermark(ctx, options.watermark, width, height, scale);
}

const px = (value: number, floor: number) => `${Math.max(floor, Math.round(value))}px`;
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

function sideLine(playback: MapPlayback, side: "me" | "opp", t: number): string {
  const stats = statsAt(playback.stats[side], t);
  const workers = statsHaveWorkers(playback.stats[side]) ? stats.workers : workerCountAt(playback.units, side, t);
  return `Supply ${Math.round(stats.supply)} · Workers ${Math.round(workers)} · Army ${getServerFormatter().number(Math.round(stats.army))}`;
}

function drawScoreboard(ctx: CanvasRenderingContext2D, options: ClipFrameOptions, t: number, width: number, scale: number): void {
  const band = Math.max(40, 66 * scale);
  const inset = Math.max(10, 22 * scale);
  ctx.save();
  ctx.fillStyle = "rgba(4,7,12,0.74)";
  ctx.fillRect(0, 0, width, band);
  ctx.textBaseline = "middle";
  const labels = { me: options.races.me || "Blue", opp: options.races.opp || "Red" };
  for (const side of ["me", "opp"] as const) {
    const left = side === "me";
    ctx.textAlign = left ? "left" : "right";
    const x = left ? inset : width - inset;
    ctx.fillStyle = left ? ME_ARMY : OPP_ARMY;
    ctx.font = `700 ${px(19 * scale, 11)} ${FONT}`;
    ctx.fillText(labels[side], x, band * 0.34);
    ctx.fillStyle = "rgba(255,255,255,0.86)";
    ctx.font = `500 ${px(14 * scale, 9)} ${FONT}`;
    ctx.fillText(sideLine(options.playback, side, t), x, band * 0.72);
  }
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.font = `700 ${px(28 * scale, 14)} ${FONT}`;
  ctx.fillText(formatClock(t), width / 2, band * 0.42);
  const viewer = visionViewer(options.vision);
  if (viewer) {
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = `600 ${px(12 * scale, 9)} ${FONT}`;
    ctx.fillText(`${labels[viewer]} vision${visionIsObserved(options.playback) ? "" : " · approximate"}`, width / 2, band * 0.82);
  }
  ctx.restore();
}

function drawWatermark(ctx: CanvasRenderingContext2D, text: string, width: number, height: number, scale: number): void {
  if (!text) return;
  ctx.save();
  ctx.font = `600 ${px(18 * scale, 10)} ${FONT}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = Math.max(2, 5 * scale);
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fillText(text, width - Math.max(8, 18 * scale), height - Math.max(6, 14 * scale));
  ctx.restore();
}
