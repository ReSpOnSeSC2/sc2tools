/** A 44px roster tile stays at least 24 physical pixels in the fitted overview. */
export const MIN_OVERVIEW_SCALE = 24 / 44;
const OVERVIEW_WIDTH = 576;
const ZOOM_STEPS = [0.75, 1, 1.25, 1.5] as const;

export function macroOverviewLayout(width: number, height: number, availableHeight: number) {
  const logicalWidth = Math.max(width, Math.min(OVERVIEW_WIDTH, width / MIN_OVERVIEW_SCALE));
  const widthScale = width > 0 ? width / logicalWidth : 1;
  const heightScale = height > 0 && availableHeight > 0 ? availableHeight / height : 1;
  const fit = Math.max(MIN_OVERVIEW_SCALE, Math.min(1, widthScale, heightScale));
  return { logicalWidth, fit };
}

/** Null is Fit, never a saved scale. Zoom-out returns to Fit at the lower bound. */
export function nextOverviewZoom(scale: number, fit: number, direction: -1 | 1): number | null {
  if (direction === 1) return ZOOM_STEPS.find((step) => step > scale + 0.001) ?? 1.5;
  const lower = [...ZOOM_STEPS].reverse().find((step) => step < scale - 0.001 && step > fit);
  return lower ?? null;
}
