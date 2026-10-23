import { CommunityAuthorSkeleton } from "@/components/community/CommunitySkeletons";

/** Shown while an author profile fetches: the page's own shape. */
export default function CommunityAuthorLoading() {
  return <CommunityAuthorSkeleton />;
}
