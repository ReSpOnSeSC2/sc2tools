"use client";

import { useApi } from "@/lib/clientApi";

export interface OwnerBuildRecord { total: number; wins: number; losses: number }
export interface OwnerPublishedBuild extends OwnerBuildRecord {
  slug: string; sourceSlug: string; title: string; matchup: string; votes: number;
  upCount: number; downCount: number; publishedAt: string; updatedAt?: string;
  removed: boolean; removedByModerator?: boolean; publishAnonymously: boolean;
}
export interface OwnerBuildsResponse { items: OwnerPublishedBuild[] }
export const ownerBuildsRefreshInterval = (latest?: OwnerBuildsResponse) => latest?.items?.length ? 15_000 : 0;

/** Account-scoped SWR deduplicates owner menus, records and the Mine view. */
export function useOwnerBuilds() {
  return useApi<OwnerBuildsResponse>("/v1/community/my-builds", { refreshInterval: ownerBuildsRefreshInterval, revalidateOnFocus: true });
}
