import { CommunityListSkeleton } from "@/components/community/CommunitySkeletons";

/**
 * Community loading skeleton: streams inside the app chrome while the
 * server fetches the build list for /community. Shaped like the page
 * (header, filter bar, CommunityBuildCard grid), the same family as the
 * build and author pages' skeletons.
 */
export default function CommunityLoading() {
  return <CommunityListSkeleton />;
}
