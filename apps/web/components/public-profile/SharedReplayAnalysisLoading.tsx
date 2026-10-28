import { SkeletonBar, SkeletonCard, SkeletonPageHeader, SkeletonRegion } from "@/components/ui/Skeleton";

/** Render only inside the replay page after its authoritative access/status gate. */
export default function SharedReplayAnalysisLoading() {
  return <SkeletonRegion label="Loading shared replay analysis" className="space-y-6">
    <SkeletonPageHeader />
    <SkeletonCard className="h-40" />
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      {Array.from({ length: 5 }, (_, index) => <SkeletonCard key={index} className={`space-y-3 ${index === 4 ? "col-span-2 lg:col-span-1" : ""}`}>
        <SkeletonBar className="h-3 w-20 max-w-full" /><SkeletonBar className="h-8 w-16 max-w-full" />
      </SkeletonCard>)}
    </div>
    <div aria-hidden className="flex flex-wrap gap-2"><SkeletonBar className="h-11 w-24" /><SkeletonBar className="h-11 w-24" /><SkeletonBar className="h-11 w-24" /></div>
    <SkeletonCard className="h-64" />
    <div className="grid gap-6 lg:grid-cols-2"><SkeletonCard className="h-56" /><SkeletonCard className="h-56" /></div>
    <div className="grid gap-6 md:grid-cols-2"><SkeletonCard className="h-48" /><SkeletonCard className="h-48" /></div>
  </SkeletonRegion>;
}
