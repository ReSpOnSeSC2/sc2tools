import {
  SkeletonBar,
  SkeletonCard,
  SkeletonRegion,
} from "@/components/ui/Skeleton";

/**
 * Devices loading skeleton: streams inside the app chrome while
 * /devices loads, shaped like the page (heading, then the pairing form
 * and the device list side by side).
 */
export default function DevicesLoading() {
  return (
    <SkeletonRegion label="Loading devices" className="space-y-6">
      <div aria-hidden className="space-y-2">
        <SkeletonBar className="h-8 w-40" />
        <SkeletonBar className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <SkeletonCard className="space-y-4 p-6">
          <SkeletonBar className="h-6 w-48" />
          <SkeletonBar className="h-4 w-full" />
          <SkeletonBar className="h-12 w-full rounded-lg" />
          <SkeletonBar className="h-10 w-32 rounded-lg" />
        </SkeletonCard>
        <SkeletonCard className="space-y-4 p-6">
          <SkeletonBar className="h-6 w-44" />
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center justify-between gap-3 rounded border border-border p-3">
              <div className="min-w-0 flex-1 space-y-2">
                <SkeletonBar className="h-4 w-48 max-w-full" />
                <SkeletonBar className="h-3 w-64 max-w-full" />
              </div>
              <SkeletonBar className="h-8 w-20 rounded-lg" />
            </div>
          ))}
        </SkeletonCard>
      </div>
    </SkeletonRegion>
  );
}
