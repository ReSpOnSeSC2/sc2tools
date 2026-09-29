"use client";

import { useSyncExternalStore } from "react";
import {
  readOverlayCreditPreference,
  setOverlayCreditPreference,
  subscribeOverlayCreditPreference,
} from "@/lib/overlayCredit";

/**
 * The streamer's "show the sc2tools.com credit" choice, shared by every
 * Settings section that hands out overlay URLs (they re-render together
 * when it flips). Defaults to shown; the server render assumes shown.
 *
 * Example:
 *   const [showCredit, setShowCredit] = useOverlayCreditPreference();
 */
export function useOverlayCreditPreference(): readonly [boolean, (show: boolean) => void] {
  const show = useSyncExternalStore(
    subscribeOverlayCreditPreference,
    readOverlayCreditPreference,
    () => true,
  );
  return [show, setOverlayCreditPreference] as const;
}
