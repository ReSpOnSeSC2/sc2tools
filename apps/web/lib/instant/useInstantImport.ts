"use client";

/**
 * React gate for the Instant Analysis importer: combines the rollout
 * flag with the signed-in user's admin bit.
 *
 *   mode "all"    → enabled
 *   mode "admins" → enabled only when `/v1/me` reports `isAdmin: true`
 *                   (signed-out visitors are never admins)
 *   mode "off"    → disabled
 *
 * `/v1/me` is only requested in "admins" mode (SWR dedupes it with the
 * rest of the app).
 *
 * Example:
 *   const { enabled, loading } = useInstantImport();
 *   if (!loading && enabled) return <BrowserImportPanel />;
 */
import { useAuth } from "@clerk/nextjs";
import { useApi } from "@/lib/clientApi";
import { getInstantImportMode, type InstantImportMode } from "./flag";

export interface InstantImportGate {
  enabled: boolean;
  mode: InstantImportMode;
  /** True while the admin check is still resolving. */
  loading: boolean;
}

/**
 * Whether the Instant Analysis importer is available to this viewer.
 *
 * Example:
 *   const gate = useInstantImport(); // { enabled: false, mode: "off", loading: false }
 */
export function useInstantImport(): InstantImportGate {
  const mode = getInstantImportMode();
  const { isLoaded, isSignedIn } = useAuth();
  const { data, isLoading } = useApi<{ isAdmin?: boolean }>(
    mode === "admins" ? "/v1/me" : null,
  );
  if (mode === "all") return { enabled: true, mode, loading: false };
  if (mode === "off") return { enabled: false, mode, loading: false };
  const loading = !isLoaded || (isSignedIn === true && isLoading && data === undefined);
  return { enabled: isSignedIn === true && data?.isAdmin === true, mode, loading };
}
