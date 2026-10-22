"use client";

import { BuildPagination } from "@/components/builds/BuildPagination";
import { useCustomBuildPage } from "@/components/builds/useCustomBuildPage";
import { RequestError } from "@/components/ui/RequestError";
import { SkeletonBar, SkeletonRegion } from "@/components/ui/Skeleton";

/** Placeholder build cards in the same grid as the loaded ones. */
function BuildCardsSkeleton() {
  return (
    <SkeletonRegion label="Loading your builds" className="grid gap-3 md:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} aria-hidden className="space-y-2 rounded-xl border border-border bg-bg-surface p-5">
          <SkeletonBar className="h-5 w-48 max-w-full" />
          <SkeletonBar className="h-4 w-32" />
        </div>
      ))}
    </SkeletonRegion>
  );
}

export function BuildsPanel() {
  const page = useCustomBuildPage();
  const { data, error, isLoading } = page;

  if (!page.hasPrevious && !isLoading && !error && data && data.items.length === 0 && (data.total ?? 0) === 0) {
    return (
      <p className="rounded-xl border border-border bg-bg-surface p-6 text-text-muted">
        No custom builds yet. The agent will sync any local custom_builds.json
        on first run.
      </p>
    );
  }
  return (
    <>
    {isLoading ? <BuildCardsSkeleton /> : null}
    {error ? <RequestError error={error} onRetry={() => page.mutate()} /> : null}
    {!isLoading && !error && data?.items.length === 0 ? <p className="text-text-muted">This page has no saved builds. Go to Previous to see the rest of your library.</p> : null}
    <div className="grid gap-3 md:grid-cols-2">
      {data?.items.map((b) => (
        <article key={b.slug} className="rounded-xl border border-border bg-bg-surface space-y-1 p-5">
          <h3 className="text-lg font-semibold">{b.name}</h3>
          <p className="text-sm text-text-muted">
            {b.race}
            {b.vsRace ? ` vs ${b.vsRace}` : ""}
            {b.updatedAt
              ? ` · updated ${new Date(b.updatedAt).toLocaleDateString()}`
              : ""}
          </p>
          {b.description && (
            <p className="text-sm text-text-muted">{b.description}</p>
          )}
        </article>
      ))}
    </div>
    <BuildPagination {...page} count={data?.items.length ?? 0} total={data?.total} loading={page.isValidating} onPrevious={page.previousPage} onNext={page.nextPage} />
    </>
  );
}
