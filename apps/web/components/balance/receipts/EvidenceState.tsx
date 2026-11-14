import type { ReactNode } from "react";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { SkeletonBar, SkeletonCard, SkeletonRegion } from "@/components/ui/Skeleton";

export function EvidenceLoading() {
  return (
    <SkeletonRegion label="Loading ladder evidence">
      <SkeletonCard className="space-y-3">
        <SkeletonBar className="h-6 w-48 max-w-full" />
        <SkeletonBar className="h-16 w-full" />
      </SkeletonCard>
    </SkeletonRegion>
  );
}

export function EvidenceNotice({ children, retry, reset }: { children: ReactNode; retry?: () => void; reset?: () => void }) {
  return (
    <div className="space-y-3 rounded-xl border border-line bg-bg-surface p-4">
      <p role="status" className="text-body text-text-muted">{children}</p>
      <div className="flex flex-wrap gap-3">
        {retry && <button type="button" className={buttonClassName({ variant: "secondary" })} onClick={retry}>Retry snapshot</button>}
        {reset && <button type="button" className={buttonClassName({ variant: "secondary" })} onClick={reset}>Use latest snapshot</button>}
      </div>
    </div>
  );
}
