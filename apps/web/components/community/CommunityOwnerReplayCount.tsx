"use client";

import { useApi } from "@/lib/clientApi";

interface OwnerStatsResponse {
  items: Array<{
    publicSlug: string;
    total: number;
    wins: number;
    losses: number;
  }>;
}

/**
 * Personal replay counts are private. The public card passes only its public
 * slug; the authenticated API returns rows owned by the current user, so no
 * private source identifier or another player's replay total reaches clients.
 */
export function CommunityOwnerReplayCount({
  publicSlug,
}: {
  publicSlug: string;
  ownerUserId?: string;
}) {
  const stats = useApi<OwnerStatsResponse>(
    "/v1/community/my-build-stats",
    {
      // Every owner card shares this SWR key, so one modest refresh keeps all
      // published-build counts current after a background reclassification.
      refreshInterval: 15_000,
      revalidateOnFocus: true,
    },
  );
  const isOwner = !!stats.data?.items.some(
    (item) => item.publicSlug === publicSlug,
  );

  // Ownership is confirmed by the owner-only slug list, not a public user id.
  if (!isOwner) return null;

  if (stats.error) {
    return (
      <span className="text-micro font-semibold text-text-muted">
        Temporarily unavailable
      </span>
    );
  }

  if (!stats.data) {
    return (
      <span
        className="text-micro font-semibold text-text-muted"
        role="status"
      >
        Loading…
      </span>
    );
  }

  const row = stats.data.items.find((item) => item.publicSlug === publicSlug);
  const total = row?.total ?? 0;
  return (
    <span
      className="text-micro font-semibold text-text-muted"
      aria-label={`${total} classified ${total === 1 ? "replay" : "replays"}`}
    >
      {total} classified {total === 1 ? "replay" : "replays"}
    </span>
  );
}
