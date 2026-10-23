"use client";

import { SkeletonBar } from "@/components/ui/Skeleton";
import { CommunityBuildRecord } from "./CommunityBuildRecord";
import { useOwnerBuilds } from "./useOwnerBuilds";

/** Private records are rendered only after the current account's membership resolves. */
export function CommunityOwnerReplayCount({ publicSlug }: { publicSlug: string; ownerUserId?: string }) {
  const query = useOwnerBuilds();
  const record = query.data?.items.find((item) => item.slug === publicSlug);
  if (!record) return null;
  if (query.error) return <span className="text-micro text-text-muted">Temporarily unavailable</span>;
  if (query.isLoading) return <span role="status" aria-label="Loading your build record"><SkeletonBar className="h-3 w-28" /></span>;
  return <CommunityBuildRecord record={record} />;
}
