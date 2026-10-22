import {
  SkeletonBar,
  SkeletonCard,
  SkeletonPageHeader,
  SkeletonRegion,
} from "@/components/ui/Skeleton";

/**
 * Community loading skeleton: streams inside the app chrome while the
 * server fetches the build list for /community, shaped like the page
 * (header, section tabs and filters, build card grid).
 */
export default function CommunityLoading() {
  return (
    <SkeletonRegion label="Loading community builds" className="space-y-6">
      <SkeletonPageHeader />
      <div aria-hidden className="flex flex-wrap gap-2">
        <SkeletonBar className="h-10 w-28 rounded-full" />
        <SkeletonBar className="h-10 w-28 rounded-full" />
        <SkeletonBar className="h-10 w-28 rounded-full" />
      </div>
      <SkeletonCard className="flex flex-wrap gap-2">
        <SkeletonBar className="h-10 w-full sm:w-72" />
        <SkeletonBar className="h-10 w-40" />
      </SkeletonCard>
      <div aria-hidden className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} className="space-y-3">
            <SkeletonBar className="h-5 w-3/4" />
            <SkeletonBar className="h-4 w-1/2" />
            <SkeletonBar className="h-4 w-full" />
            <SkeletonBar className="h-4 w-5/6" />
          </SkeletonCard>
        ))}
      </div>
    </SkeletonRegion>
  );
}
