import type { OverlayCanvas, WidgetPlacement } from "@/lib/overlayLayout";

export const CANVAS_SIZE = {
  landscape: { width: 1920, height: 1080 },
  vertical: { width: 1080, height: 1920 },
} satisfies Record<OverlayCanvas, { width: number; height: number }>;
export type CanvasSize = (typeof CANVAS_SIZE)[OverlayCanvas];
export type PreviewBox = { left: number; top: number; width: number; height: number };

const percent = (value: number) => Math.round(Math.min(100, Math.max(0, value)) * 10000) / 10000;
const grid = (pixels: number, snap: boolean) => snap ? Math.round(pixels / 8) * 8 : pixels;

export function moveWidget(placement: WidgetPlacement, dx: number, dy: number, size: CanvasSize, snap = false): WidgetPlacement {
  const x = grid(placement.xPct * size.width / 100 + dx, snap);
  const edgeDistance = placement.yPct * size.height / 100;
  const y = grid(edgeDistance + (placement.anchor === "top" ? dy : -dy), snap);
  return { ...placement, xPct: percent(x * 100 / size.width), yPct: percent(y * 100 / size.height) };
}

export function defaultWidgetPlacement(box?: PreviewBox): WidgetPlacement {
  return { anchor: "top", xPct: box ? percent(box.left + box.width / 2) : 50,
    yPct: box ? percent(box.top) : 20, scale: 1, zIndex: 0 };
}

export function changeWidgetAnchor(placement: WidgetPlacement, anchor: WidgetPlacement["anchor"], box?: PreviewBox): WidgetPlacement {
  if (anchor === placement.anchor) return placement;
  const boxHeight = box?.height ?? 0;
  return { ...placement, anchor, yPct: percent(100 - placement.yPct - boxHeight) };
}
