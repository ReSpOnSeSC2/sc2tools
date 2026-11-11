"use client";

import { useEffect } from "react";
import { useAuth } from "@clerk/nextjs";
import { useApi } from "@/lib/clientApi";
import { readStoredAppearance, sameAppearance, sanitizeAppearance, setStoredAppearance } from "@/lib/appearance";

/**
 * Brings the signed-in account's appearance preferences (text size,
 * density, formats) to this browser once per visit. The browser copy
 * already applied them before paint, so this changes the page only when
 * they were changed on another device or another account signed in here.
 */
export function AppearanceAccountSync() {
  const { isLoaded, isSignedIn } = useAuth();
  const { data } = useApi<unknown>(isLoaded && isSignedIn ? "/v1/me/preferences/appearance" : null, {
    revalidateOnFocus: false,
    revalidateIfStale: false,
    shouldRetryOnError: false,
  });
  useEffect(() => {
    if (data === undefined || data === null) return;
    const account = sanitizeAppearance(data);
    if (!sameAppearance(account, readStoredAppearance())) setStoredAppearance(account);
  }, [data]);
  return null;
}
