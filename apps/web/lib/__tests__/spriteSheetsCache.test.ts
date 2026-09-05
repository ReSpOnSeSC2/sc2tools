import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpriteAnimHandle } from "../spriteSheets";

let sheets: typeof import("../spriteSheets");
let ctx: CanvasRenderingContext2D;
let images: TestImage[];
let bitmaps: Array<{ width: number; height: number; close: ReturnType<typeof vi.fn> }>;

class TestImage {
  src = "";
  crossOrigin = "";
  decoding = "";
  naturalWidth = 2048;
  naturalHeight = 2048;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  removeAttribute() {}
  constructor() { images.push(this); }
}

beforeEach(async () => {
  vi.resetModules();
  images = [];
  bitmaps = [];
  ctx = { drawImage: vi.fn(), clearRect: vi.fn() } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
  vi.stubGlobal("Image", TestImage);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => {
    const bitmap = { width: 2048, height: 2048, close: vi.fn() };
    bitmaps.push(bitmap);
    return bitmap;
  }));
  sheets = await import("../spriteSheets");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function handle(name: string) {
  return sheets.spriteAnim(sheets.resolveSprite(name, "unit")!, "Attack");
}
function draw(handles: SpriteAnimHandle[], size = 32) {
  sheets.beginSpriteFrame(1);
  const result = handles.map(h => sheets.drawSprite(ctx, h, "blue", 0, 0, 0, 0, size));
  sheets.endSpriteFrame();
  return result;
}
async function loadAll() {
  // Each completion opens a slot for the next queued image. The event callback
  // is cleared after settlement, just as a browser load fires only once.
  for (let i = 0; i < images.length; i += 1) {
    images[i].onload?.();
    await Promise.resolve();
    await Promise.resolve();
  }
}

describe("replay sprite decoded memory", () => {
  it("loads only a drawn animation/color and limits concurrent fetch/decode starts", async () => {
    const handles = ["Marine", "Zealot", "Hydralisk", "Stalker"].map(handle);
    expect(images).toHaveLength(0);
    draw(handles);
    expect(images).toHaveLength(2);
    expect(sheets.spriteAtlasStats().loading).toBe(2);
    expect(images.every(img => img.src.includes("_blue_Attack.webp"))).toBe(true);
    images[0].onload?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(images).toHaveLength(3);
    expect(sheets.spriteAtlasStats().loading).toBe(2);
    await loadAll();
    expect(images).toHaveLength(4);
    expect(sheets.spriteAtlasStats().loading).toBe(0);
  });

  it("releases historical originals and draws their existing atlases without reloading", async () => {
    const handles = ["Marine", "Zealot", "Hydralisk", "Stalker", "Roach", "Ravager", "Adept", "Archon"].map(handle);
    for (const h of handles) {
      draw([h]);
      await loadAll();
      draw([h]);
    }
    const stats = sheets.spriteAtlasStats();
    expect(stats.decodedBytes).toBeLessThanOrEqual(96 * 1024 * 1024);
    expect(stats.decodedSheets).toBeLessThan(handles.length);
    expect(bitmaps[0].close).toHaveBeenCalledOnce();
    const downloads = images.length;
    for (let frame = 0; frame < 3; frame += 1) expect(draw(handles).every(Boolean)).toBe(true);
    expect(images).toHaveLength(downloads);
    expect(sheets.spriteAtlasStats().loading).toBe(0);
  });

  it("protects a visible atlas working set larger than its target instead of thrashing", async () => {
    const { SPRITE_MANIFEST } = await import("../spriteManifest.generated");
    const handles: SpriteAnimHandle[] = [];
    for (const [name, meta] of Object.entries(SPRITE_MANIFEST)) {
      if (meta.kind !== "unit") continue;
      const sprite = sheets.resolveSprite(name, "unit")!;
      for (const anim of Object.keys(meta.anims)) {
        if (meta.frameSize === 256 && meta.anims[anim].cols === 8 && meta.anims[anim].rows === 8) {
          handles.push(sheets.spriteAnim(sprite, anim));
          if (handles.length === 49) break;
        }
      }
      if (handles.length === 49) break;
    }
    expect(handles).toHaveLength(49);
    draw(handles, 64);
    await loadAll();
    // At most two atlases are built per frame, including while paused.
    for (let frame = 0; frame < 25; frame += 1) draw(handles, 64);
    expect(sheets.spriteAtlasStats().atlases).toBe(49);
    expect(sheets.spriteAtlasStats().bytes).toBe(49 * 1024 * 1024);
    expect(sheets.spriteAtlasStats().decodedBytes).toBeLessThanOrEqual(96 * 1024 * 1024);
    const downloads = images.length;
    for (let frame = 0; frame < 3; frame += 1) expect(draw(handles, 64).every(Boolean)).toBe(true);
    expect(images).toHaveLength(downloads);
    draw([handles[0]], 64);
    expect(sheets.spriteAtlasStats().bytes).toBeLessThanOrEqual(48 * 1024 * 1024);
  });

  it("keeps originals needed by a large zoomed working set until they leave the frame", async () => {
    const handles = ["Marine", "Zealot", "Hydralisk", "Stalker", "Roach", "Ravager", "Adept"].map(handle);
    draw(handles, 128);
    await loadAll();
    expect(draw(handles, 128).every(Boolean)).toBe(true);
    expect(sheets.spriteAtlasStats().decodedBytes).toBe(7 * 16 * 1024 * 1024);
    expect(bitmaps.every(bitmap => bitmap.close.mock.calls.length === 0)).toBe(true);
    const downloads = images.length;
    expect(draw(handles, 128).every(Boolean)).toBe(true);
    expect(images).toHaveLength(downloads);
    draw([handles[0]], 128);
    expect(sheets.spriteAtlasStats().decodedBytes).toBeLessThanOrEqual(96 * 1024 * 1024);
  });
});
