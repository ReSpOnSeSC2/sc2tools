"use client";

import { createContext, useContext } from "react";

/**
 * The selected token's Instant preferences. Live sources receive credit
 * changes from the profile. Ghost voice uses the copied widget URL.
 */
export interface OverlayFlags {
  /** Show the "Overlay by sc2tools.com" credit. */
  credit: boolean;
  /** Add a QR code to the credit in eligible scenes. */
  creditQr: boolean;
  /** Ghost Build speaks each step. */
  ghostVoice: boolean;
  /** A profile save is in flight; the switches wait for it. */
  busy: boolean;
  setCredit: (show: boolean) => void;
  setCreditQr: (show: boolean) => void;
  setGhostVoice: (on: boolean) => void;
}

export const DEFAULT_OVERLAY_FLAGS: OverlayFlags = {
  credit: true,
  creditQr: false,
  ghostVoice: false,
  busy: false,
  setCredit: () => {},
  setCreditQr: () => {},
  setGhostVoice: () => {},
};

export const OverlayFlagsContext = createContext<OverlayFlags>(DEFAULT_OVERLAY_FLAGS);

/** The selected token's flags, from OverlayProfileEditor. */
export function useOverlayFlags(): OverlayFlags {
  return useContext(OverlayFlagsContext);
}
