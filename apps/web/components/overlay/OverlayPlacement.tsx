"use client";

import { createContext, useContext, type ReactNode } from "react";
import { overlayPlacementStyle, type WidgetPlacement } from "@/lib/overlayLayout";

const PlacementContext = createContext<WidgetPlacement | undefined>(undefined);

export function OverlayPlacement({ placement, children }: { placement?: WidgetPlacement; children: ReactNode }) {
  return <PlacementContext.Provider value={placement}>{children}</PlacementContext.Provider>;
}

export function useOverlayPlacement() {
  const placement = useContext(PlacementContext);
  return placement ? overlayPlacementStyle(placement) : undefined;
}
