import type { ReplayCanvas, ReplayCanvasContext } from "@/lib/replayCanvas";
import type { ClipFormat } from "@/lib/clip/clipPlan";
import { ClipError } from "./clipRecorder";

export type ClipSurface = {
  canvas: ReplayCanvas;
  ctx: ReplayCanvasContext;
  captureCanvas: HTMLCanvasElement | null;
  present: () => void;
  dispose: () => void;
};

function htmlCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function tryOffscreen(width: number, height: number, capture: CanvasRenderingContext2D | null) {
  if (typeof OffscreenCanvas !== "function") return null;
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", capture ? undefined : { willReadFrequently: true });
    if (!ctx) return null;
    // Probe the copy separately from the encoder. Some implementations
    // expose OffscreenCanvas without accepting it as a canvas image source.
    capture?.drawImage(canvas, 0, 0);
    return { canvas, ctx };
  } catch {
    return null;
  }
}

export function createClipSurface(width: number, height: number, format: ClipFormat): ClipSurface {
  // MediaRecorder captures an HTML canvas. The GIF worker needs only RGBA.
  const captureCanvas = format === "video" ? htmlCanvas(width, height) : null;
  const capture = captureCanvas?.getContext("2d") ?? null;
  if (captureCanvas && !capture) throw new ClipError("unsupported");
  const offscreen = tryOffscreen(width, height, capture);
  const fallback = captureCanvas ?? (offscreen ? null : htmlCanvas(width, height));
  const canvas = offscreen?.canvas ?? fallback;
  const ctx = offscreen?.ctx ?? capture ?? fallback?.getContext("2d", { willReadFrequently: true });
  if (!canvas || !ctx) throw new ClipError("unsupported");

  if (captureCanvas) {
    captureCanvas.setAttribute("aria-hidden", "true");
    Object.assign(captureCanvas.style, { position: "fixed", left: "0", top: "0", width: "1px", height: "1px", opacity: "0", pointerEvents: "none" });
    document.body.appendChild(captureCanvas);
  }
  return {
    canvas, ctx, captureCanvas,
    present: () => { if (offscreen && capture) capture.drawImage(offscreen.canvas, 0, 0); },
    dispose: () => {
      captureCanvas?.remove();
      canvas.width = canvas.height = 0;
      if (captureCanvas && captureCanvas !== canvas) captureCanvas.width = captureCanvas.height = 0;
    },
  };
}
