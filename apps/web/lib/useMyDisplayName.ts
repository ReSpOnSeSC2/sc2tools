"use client";

import { useApi } from "@/lib/clientApi";

type MeProfileResp = {
  displayName?: string | null;
  battleTag?: string | null;
};

/**
 * The logged-in user's preferred display name for "you" labels in
 * game lists. Reads the same `/v1/me/profile` the Settings → Profile
 * panel writes; falls back to the battleTag (minus its `#1234`
 * discriminator) when no display name has been set. Returns `null`
 * until something usable resolves so callers can render a neutral
 * "You" placeholder rather than flashing an empty string.
 *
 * SWR-cached and revalidate-on-focus-off — the value changes only
 * when the user edits their profile, so a per-mount refetch is waste.
 */
export function useMyDisplayName(): string | null {
  const { data } = useApi<MeProfileResp>("/v1/me/profile", {
    revalidateOnFocus: false,
  });
  const name = (data?.displayName || "").trim();
  if (name) return name;
  const tag = (data?.battleTag || "").trim();
  if (tag) return tag.split("#")[0] || tag;
  return null;
}
