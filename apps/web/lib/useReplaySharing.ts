"use client";

import { useAuth } from "@clerk/nextjs";
import type { ReplaySharingResponse } from "@/components/analyzer/replays/types";
import { sharedAnalysisHref } from "@/components/public-profile/archiveQuery";
import { apiCall, useApi } from "./clientApi";
import { isPublicReplayReference } from "./replayRouteAccess";

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

/** Resolve the archive's opaque reference without putting a legacy ID in a URL. */
export async function getPublicReplayReference(
  getToken: () => Promise<string | null>,
  gameId: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await apiCall<{ reference?: unknown }>(getToken, REPLAY_SHARING_PATH + "/reference", {
    method: "POST", body: JSON.stringify({ gameId }), signal,
  });
  if (!isPublicReplayReference(result?.reference)) throw new Error("This game's public link could not be confirmed.");
  return result.reference;
}

/** A public replay URL may only contain the archive's opaque reference. */
export function publicGameHref(handle: string, reference: string, origin: string): string | null {
  if (!isPublicReplayReference(reference)) return null;
  return `${origin}${sharedAnalysisHref(`/players/${encodeURIComponent(handle)}/replays`, reference)}`;
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
  const sharing = validReplaySharing(request.data) ? request.data : null;
  return {
    sharing,
    unavailable: Boolean(request.error) || (request.data !== undefined && !sharing),
    /** Write ``enabled`` and adopt the confirmed answer. */
    setEnabled: async (enabled: boolean, signal?: AbortSignal): Promise<ReplaySharingResponse> => {
      const next = await putReplaySharing(getToken, enabled, signal);
      signal?.throwIfAborted();
      await request.mutate(next, { revalidate: false });
      return next;
    },
  };
}
