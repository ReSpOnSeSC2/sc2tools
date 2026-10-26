"use client";

import { createContext, useContext } from "react";

const OverlayLayer = createContext(49);
export const OverlayLayerProvider = OverlayLayer.Provider;

/** React ownership crosses portals. Stay below the global toast layer (60).
 * A custom portal host must still allow normal stacking: an ancestor's CSS
 * stacking context can constrain its descendants regardless of this value.
 */
export function useOverlayLayer() {
  return Math.min(59, useContext(OverlayLayer) + 1);
}
