"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import type { ReplaySharingResponse } from "@/components/analyzer/replays/types";
import { sharedAnalysisHref } from "@/components/public-profile/archiveQuery";
import { apiCall, useApi } from "./clientApi";

/**
 * Public replay sharing (the account-wide archive at /players/<handle>/replays),
 * as one toggle shared by the Replays page control and the game Share menu.
 * Turning it on needs explicit consent in both places; this module owns the
 * read, its validation and the consent write itself.
 */

export const REPLAY_SHARING_PATH = "/v1/me/replay-sharing";

/** A usable settings answer: an enabled archive always has a handle. */
export function validReplaySharing(value: unknown): value is ReplaySharingResponse {
  if (!value || typeof value !== "object" || !("enabled" in value) || !("handle" in value)) return false;
  return typeof value.enabled === "boolean" && (value.handle === null || typeof value.handle === "string")
    && (!value.enabled || typeof value.handle === "string" && value.handle.length > 0);
}

/**
 * The consent write. Resolves only with a server answer confirming the
 * requested state; anything else throws, so callers never assume a change.
 */
export async function putReplaySharing(
  getToken: () => Promise<string | null>,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<ReplaySharingResponse> {
  const result = await apiCall<ReplaySharingResponse>(getToken, REPLAY_SHARING_PATH,
    { method: "PUT", body: JSON.stringify({ enabled }), signal });
  if (!validReplaySharing(result) || result.enabled !== enabled) throw new Error("Sharing status could not be confirmed.");
  return result;
}

/**
 * A game's address on the owner's public replay page.
 *
 * Example: `publicGameHref("bob", "g|1", "https://sc2tools.com")`
 * → "https://sc2tools.com/players/bob/replays/g%7C1".
 */
export function publicGameHref(handle: string, gameId: string, origin: string): string {
  return `${origin}${sharedAnalysisHref(`/players/${encodeURIComponent(handle)}/replays`, gameId)}`;
}

/**
 * Replay-sharing state for a share menu, read only while ``active`` (the
 * menu has been opened). ``unavailable`` covers a failed read or a 401, so
 * hosts hide the public rows silently.
 */
export function useReplaySharing(active: boolean) {
  const { getToken } = useAuth();
  const request = useApi<ReplaySharingResponse>(active ? REPLAY_SHARING_PATH : null,
    { revalidateOnFocus: false, shouldRetryOnError: false });
  const [saving, setSaving] = useState(false);
  const sharing = validReplaySharing(request.data) ? request.data : null;
  const handle = sharing?.enabled && sharing.handle ? sharing.handle : null;
  return {
    sharing,
    unavailable: Boolean(request.error) || (request.data !== undefined && !sharing),
    saving,
    /** Write ``enabled`` and adopt the confirmed answer. */
    setEnabled: async (enabled: boolean): Promise<ReplaySharingResponse> => {
      setSaving(true);
      try {
        const next = await putReplaySharing(getToken, enabled);
        await request.mutate(next, { revalidate: false });
        return next;
      } finally {
        setSaving(false);
      }
    },
    /** The game's public address while sharing is on, else null. */
    publicGameHref: (gameId: string) => (handle ? publicGameHref(handle, gameId, window.location.origin) : null),
  };
}
