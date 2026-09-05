import { projectX, projectY, type PlaybackBounds, type ReplayCreep } from "./mapReplay";

/** Last observed mask, never a mask from the future. Works for reverse seeks. */
export function creepFrameAt(creep: ReplayCreep, t: number): number {
  let lo = 0, hi = creep.frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (creep.frames[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

interface MaskCache { index: number; canvas: HTMLCanvasElement }
const masks = new WeakMap<ReplayCreep, MaskCache>();

/** Cached at map-cell resolution. Only rebuild when the observed mask changes. */
export function drawObservedCreep(
  ctx: CanvasRenderingContext2D,
  bounds: PlaybackBounds,
  projection: { k: number; ox: number; oy: number },
  creep: ReplayCreep,
  t: number,
): void {
  const index = creepFrameAt(creep, t);
  if (index < 0 || typeof document === "undefined") return;
  let cache = masks.get(creep);
  if (!cache) {
    const canvas = document.createElement("canvas");
    canvas.width = creep.width;
    canvas.height = creep.height;
    cache = { index: -1, canvas };
    masks.set(creep, cache);
  }
  if (cache.index !== index) {
    const mask = cache.canvas.getContext("2d");
    if (!mask) return;
    mask.clearRect(0, 0, creep.width, creep.height);
    mask.fillStyle = "rgba(106, 48, 139, 0.52)";
    const runs = creep.frames[index].runs;
    for (let i = 0; i + 1 < runs.length; i += 2) {
      let cell = runs[i], remaining = runs[i + 1];
      while (remaining > 0) {
        const x = cell % creep.width;
        const y = Math.floor(cell / creep.width);
        const length = Math.min(remaining, creep.width - x);
        mask.fillRect(x, creep.height - 1 - y, length, 1);
        cell += length;
        remaining -= length;
      }
    }
    cache.index = index;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(projection.ox, projection.oy, (bounds.maxX - bounds.minX) * projection.k,
    (bounds.maxY - bounds.minY) * projection.k);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(cache.canvas, projectX(bounds, projection, 0), projectY(bounds, projection, creep.height),
    creep.width * projection.k, creep.height * projection.k);
  ctx.restore();
}
