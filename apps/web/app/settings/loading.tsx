import {
  SkeletonBar,
  SkeletonCard,
  SkeletonPageHeader,
  SkeletonRegion,
} from "@/components/ui/Skeleton";

/**
 * Settings loading skeleton: streams inside the app chrome while
 * /settings loads, shaped like the page (header, the tab rail on wide
 * screens or the tab strip on phones, then a section of cards).
 */
export default function SettingsLoading() {
  return (
    <SkeletonRegion label="Loading settings" className="space-y-6">
      <SkeletonPageHeader />
      <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <div aria-hidden className="flex gap-2 overflow-hidden lg:flex-col">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonBar key={i} className="h-10 w-24 shrink-0 rounded-lg lg:w-full" />
          ))}
        </div>
        <div className="space-y-5">
          <SkeletonCard className="space-y-3">
            <SkeletonBar className="h-5 w-40" />
            <SkeletonBar className="h-4 w-3/4" />
            <div className="grid gap-2 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <SkeletonBar key={i} className="h-11 rounded-lg" />
              ))}
            </div>
          </SkeletonCard>
          <SkeletonCard className="space-y-3">
            <SkeletonBar className="h-5 w-32" />
            <SkeletonBar className="h-11 rounded-lg" />
            <SkeletonBar className="h-11 rounded-lg" />
          </SkeletonCard>
        </div>
      </div>
    </SkeletonRegion>
  );
}
