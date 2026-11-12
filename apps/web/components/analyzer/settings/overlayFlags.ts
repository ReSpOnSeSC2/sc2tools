"use client";

import { createContext, useContext } from "react";

/**
 * The selected token's Instant preferences. Live sources receive credit
 * changes from the profile. Ghost voice uses the copied widget URL.
 */
export interface OverlayFlags {
  /** Show the "Overlay by sc2tools.com" credit. */
  credit: boolean;
  /** Ghost Build speaks each step. */
  ghostVoice: boolean;
  /** A profile save is in flight; the switches wait for it. */
  busy: boolean;
  setCredit: (show: boolean) => void;
  setGhostVoice: (on: boolean) => void;
}

export const DEFAULT_OVERLAY_FLAGS: OverlayFlags = {
  credit: true,
  ghostVoice: false,
  busy: false,
  setCredit: () => {},
  setGhostVoice: () => {},
};

export const OverlayFlagsContext = createContext<OverlayFlags>(DEFAULT_OVERLAY_FLAGS);

/** The selected token's flags, from OverlayProfileEditor. */
export function useOverlayFlags(): OverlayFlags {
  return useContext(OverlayFlagsContext);
}
