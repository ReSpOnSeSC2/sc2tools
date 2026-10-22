import {
  SkeletonBar,
  SkeletonCard,
  SkeletonPageHeader,
  SkeletonRegion,
} from "@/components/ui/Skeleton";

/**
 * Build library loading skeleton: streams inside the app chrome while
 * /builds loads, shaped like the page (header, filter bar, card grid)
 * so nothing jumps when the library arrives.
 */
export default function BuildsLoading() {
  return (
    <SkeletonRegion label="Loading your build library" className="space-y-6">
      <SkeletonPageHeader />
      <SkeletonCard className="flex flex-wrap gap-2">
        <SkeletonBar className="h-10 w-full sm:w-64" />
        <SkeletonBar className="h-10 w-32" />
        <SkeletonBar className="h-10 w-28" />
      </SkeletonCard>
      <div aria-hidden className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} className="space-y-3">
            <SkeletonBar className="h-5 w-3/4" />
            <SkeletonBar className="h-4 w-1/3" />
            <div className="grid grid-cols-3 gap-2 pt-2">
              <SkeletonBar className="h-8" />
              <SkeletonBar className="h-8" />
              <SkeletonBar className="h-8" />
            </div>
          </SkeletonCard>
        ))}
      </div>
    </SkeletonRegion>
  );
}
