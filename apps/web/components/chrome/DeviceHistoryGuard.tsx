"use client";

import { useEffect } from "react";
import { useAuth } from "@clerk/nextjs";
import { DEVICE_NOTE_KEY } from "@/lib/analysisCorpus/deviceKeys";

/**
 * Game history this browser keeps on the device belongs to one signed-in account. On every signed-in surface, once
 * Clerk has loaded, a copy noted for another account, or for nobody (signed out), is removed. Only the note is read
 * here; the clearing code loads on demand, so the guard adds next to nothing to each page's first load.
 */
export function DeviceHistoryGuard() {
  const { isLoaded, isSignedIn, userId } = useAuth();

  useEffect(() => {
    if (!isLoaded) return;
    let noted: string | null;
    try {
      noted = window.localStorage.getItem(DEVICE_NOTE_KEY);
    } catch {
      // Storage is refused: no copy can have been noted.
      return;
    }
    const owner = isSignedIn && userId ? userId : null;
    if (!noted || noted === owner) return;
    void import("@/lib/analysisCorpus/deviceNote")
      .then(({ forgetDeviceCopy }) => forgetDeviceCopy())
      .catch(() => undefined);
  }, [isLoaded, isSignedIn, userId]);

  return null;
}
