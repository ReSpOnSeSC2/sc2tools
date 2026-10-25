import Link from "next/link";
import { UserX } from "lucide-react";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { SkeletonBar, SkeletonCard, SkeletonRegion } from "@/components/ui/Skeleton";
import type { RequestErrorProps } from "@/components/ui/RequestError";

/**
 * The opponent dossier's non-content states (ProfileView): its loading
 * skeleton, the "not in your history" state for a 404, and the copy for
 * a dossier request the server is too busy to answer.
 */

/** Shaped like the dossier header (name, 4 stat tiles) and its first two cards. */
export function DossierSkeleton() {
  return (
    <SkeletonRegion label="Loading opponent dossier" className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4" aria-hidden>
        <div className="w-full space-y-2 sm:w-auto sm:flex-1">
          <SkeletonBar className="h-8 w-56 max-w-full" />
          <SkeletonBar className="h-4 w-40" />
        </div>
        <div className="grid w-full grid-cols-2 gap-3 sm:w-auto sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} className="sm:w-24">
              <SkeletonBar className="h-3 w-10" />
              <SkeletonBar className="mt-2 h-6 w-12" />
            </SkeletonCard>
          ))}
        </div>
      </div>
      <SkeletonCard className="h-32" />
      <SkeletonCard className="h-64" />
    </SkeletonRegion>
  );
}

/** The API has no opponent with this id in the signed-in player's games. */
export function OpponentNotFound() {
  return (
    <div className="rounded-xl border-2 border-line bg-bg-surface shadow-hard">
      <EmptyStatePanel
        icon={<UserX className="h-5 w-5" aria-hidden />}
        title="Not in your history"
        description="The link may be out of date, or the games against them were deleted."
        action={
          <Link
            href="/app/opponents"
            className="hard-press inline-flex h-9 min-w-[44px] items-center justify-center rounded-full border-2 border-line bg-bg-surface px-4 font-display text-caption font-bold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            Back to opponents
          </Link>
        }
      />
    </div>
  );
}

const DOSSIER_BUSY = {
  title: "The dossier is busy, try again in a moment",
  body: "Building a dossier is one of the heaviest requests, and the server builds a few at a time.",
};

/** RequestError copy for an explicitly busy dossier request. */
export const DOSSIER_ERROR_COPY: RequestErrorProps["copy"] = {
  busy: DOSSIER_BUSY,
};
