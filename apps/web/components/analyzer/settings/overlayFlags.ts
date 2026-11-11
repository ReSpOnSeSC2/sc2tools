"use client";

import { createContext, useContext } from "react";

/**
 * The account-wide overlay choices of the selected token (its overlay
 * profile), shared by every Settings section that hands out URLs. Both
 * save as soon as they change (they are Instant controls) and follow the
 * account to any browser; copied URLs carry them as `credit=0` and
 * `voice=1`, so existing OBS sources keep working unchanged.
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
