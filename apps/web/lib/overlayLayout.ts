import type { CSSProperties } from "react";
import type { WidgetId } from "@/components/overlay/widgetLifecycle";
import presence from "./overlayPresenceRules.json";
import rules from "./overlayProfileRules.json";

export type OverlayCanvas = "landscape" | "vertical";
export type WidgetPlacement = { anchor: "top" | "bottom"; xPct: number; yPct: number; scale: number; zIndex: number };
export type OverlayLayout = Partial<Record<WidgetId, WidgetPlacement>>;
export const LAYOUT_WIDGETS: readonly WidgetId[] = presence.compositeWidgets as WidgetId[];
export const LAYOUT_LIMITS = rules.layout;

const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/** Old profiles have no overrides. Ignore malformed rows without hiding other cards. */
export function normalizeOverlayLayout(raw: unknown): OverlayLayout | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, Partial<WidgetPlacement>>;
  const layout: OverlayLayout = {};
  for (const id of LAYOUT_WIDGETS) {
    const row = Object.hasOwn(input, id) ? input[id] : null;
    if (!row || (row.anchor !== "top" && row.anchor !== "bottom")) continue;
    const { anchor, xPct, yPct, scale, zIndex = 0 } = row;
    if (!inRange(xPct, 0, 100) || !inRange(yPct, 0, 100)
      || !inRange(scale, LAYOUT_LIMITS.minScale, LAYOUT_LIMITS.maxScale)
      || !Number.isInteger(zIndex) || !inRange(zIndex, 0, LAYOUT_LIMITS.maxLayer)) continue;
    layout[id] = { anchor, xPct, yPct, scale, zIndex };
  }
  return Object.keys(layout).length ? layout : undefined;
}

/** x is the widget center. y is measured from the chosen canvas edge. */
export function overlayPlacementStyle(placement: WidgetPlacement): CSSProperties {
  return {
    left: `${placement.xPct}%`,
    [placement.anchor]: `${placement.yPct}%`,
    transform: `translateX(-50%) scale(${placement.scale})`,
    transformOrigin: `center ${placement.anchor}`,
    zIndex: placement.zIndex,
  };
}
