import type { ReactNode } from "react";

/**
 * Loading placeholders for the public community pages, shaped like the
 * pages they stand in for so nothing jumps when the content arrives.
 * Used by the route-level loading.tsx files; server-component safe.
 *
 *   CommunityListSkeleton   — /community: filter bar + 6 build cards
 *   CommunityBuildSkeleton  — /community/builds/<slug>: header,
 *                             8 build-order rows, 3 sidebar blocks
 *   CommunityAuthorSkeleton — /community/authors/<id>: header,
 *                             4 stat tiles, 6 build cards
 */

const PANEL = "rounded-xl border-2 border-line bg-bg-surface shadow-hard";

function Bone({ className }: { className: string }) {
  return <div className={`rounded bg-bg-elevated motion-safe:animate-pulse ${className}`} />;
}

function SkeletonRoot({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" className="space-y-6">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

function HeaderBones() {
  return (
    <div className="space-y-2">
      <Bone className="h-3 w-32" />
      <Bone className="h-9 w-2/3 max-w-md" />
      <Bone className="h-4 w-full max-w-xl" />
    </div>
  );
}

/** One CommunityBuildCard: race rail, chips, title, two lines, meta row. */
function BuildCardBones() {
  return (
    <div className={`relative h-full overflow-hidden ${PANEL}`}>
      <div className="absolute left-0 top-0 h-full w-1 bg-bg-elevated" />
      <div className="flex h-full flex-col gap-3 p-5 pl-6">
        <div className="flex gap-2">
          <Bone className="h-5 w-14 rounded-full" />
          <Bone className="h-5 w-20 rounded-full" />
        </div>
        <Bone className="h-5 w-3/4" />
        <div className="space-y-1.5">
          <Bone className="h-3 w-full" />
          <Bone className="h-3 w-5/6" />
        </div>
        <div className="mt-auto flex gap-3 pt-2">
          <Bone className="h-3 w-16" />
          <Bone className="h-3 w-12" />
        </div>
      </div>
    </div>
  );
}

function BuildCardGrid() {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-hidden>
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="h-full">
          <BuildCardBones />
        </li>
      ))}
    </ul>
  );
}

export function CommunityListSkeleton() {
  return (
    <SkeletonRoot label="Loading community builds…">
      <HeaderBones />
      <div className="space-y-3" aria-hidden>
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
          <Bone className="h-11 flex-1 rounded-lg" />
          <Bone className="h-11 w-full rounded-lg md:w-40" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: 7 }, (_, i) => (
            <Bone key={i} className="h-8 w-14 rounded-full" />
          ))}
        </div>
      </div>
      <BuildCardGrid />
    </SkeletonRoot>
  );
}

export function CommunityBuildSkeleton() {
  return (
    <SkeletonRoot label="Loading build…">
      <Bone className="h-4 w-36" />
      <HeaderBones />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]" aria-hidden>
        <div className={`divide-y divide-border ${PANEL}`}>
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 p-4">
              <Bone className="h-4 w-12" />
              <Bone className="h-6 w-6 rounded-md" />
              <Bone className="h-4 flex-1" />
            </div>
          ))}
        </div>
        <div className="space-y-4">
          {/* Vote panel, save/share actions, build facts. */}
          {["h-24", "h-28", "h-40"].map((height) => (
            <div key={height} className={`p-4 ${PANEL}`}>
              <Bone className={`w-full ${height}`} />
            </div>
          ))}
        </div>
      </div>
    </SkeletonRoot>
  );
}

export function CommunityAuthorSkeleton() {
  return (
    <SkeletonRoot label="Loading author profile…">
      <Bone className="h-4 w-36" />
      <div className={`space-y-3 px-5 py-6 sm:px-6 sm:py-8 ${PANEL}`} aria-hidden>
        <Bone className="h-3 w-24" />
        <Bone className="h-9 w-1/2 max-w-sm" />
        <Bone className="h-4 w-full max-w-lg" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-hidden>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className={`space-y-2 p-4 ${PANEL}`}>
            <Bone className="h-3 w-16" />
            <Bone className="h-7 w-12" />
          </div>
        ))}
      </div>
      <BuildCardGrid />
    </SkeletonRoot>
  );
}
