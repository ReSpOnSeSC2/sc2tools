import type { ReactNode } from "react";

/**
 * Skeleton pieces for loading states shaped like the content they stand
 * in for, so nothing jumps when the data arrives. (The table-row
 * `Skeleton` in Card.tsx stays for list views.)
 *
 *   <SkeletonRegion label="Loading devices">
 *     <SkeletonCard className="space-y-2">
 *       <SkeletonBar className="h-4 w-40" />
 *       <SkeletonBar className="h-3 w-24" />
 *     </SkeletonCard>
 *   </SkeletonRegion>
 *
 * Server-component safe. The pulse is motion-safe, so it stops under
 * reduced motion.
 */

/** One grey bar; size it with height and width classes. */
export function SkeletonBar({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={["rounded bg-bg-elevated motion-safe:animate-pulse", className].filter(Boolean).join(" ")}
    />
  );
}

/**
 * Table-like rows without card chrome, for loading inside a Card that
 * is already on screen (Card.tsx's `Skeleton` draws its own card).
 */
export function SkeletonRows({ rows = 4, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <SkeletonRegion label={label} className="divide-y divide-border">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-4 py-3" aria-hidden>
          <SkeletonBar className="h-4 w-32" />
          <SkeletonBar className="h-4 w-12" />
          <SkeletonBar className="h-4 w-12" />
          <SkeletonBar className="hidden h-4 w-24 sm:block" />
        </div>
      ))}
    </SkeletonRegion>
  );
}

/** PageHeader's shape: eyebrow, title and a line of description. */
export function SkeletonPageHeader() {
  return (
    <div aria-hidden className="space-y-2">
      <SkeletonBar className="h-3 w-24" />
      <SkeletonBar className="h-9 w-64 max-w-full" />
      <SkeletonBar className="h-4 w-96 max-w-full" />
    </div>
  );
}

/** A card-shaped shell matching Card's outline, for skeleton content. */
export function SkeletonCard({ className = "", children }: { className?: string; children?: ReactNode }) {
  return (
    <div
      aria-hidden
      className={["rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard", className].filter(Boolean).join(" ")}
    >
      {children}
    </div>
  );
}

/** A chart-shaped loading state with one announcement and decorative bars. */
export function SkeletonChart({ label = "Loading chart", className = "" }: { label?: string; className?: string }) {
  return <SkeletonRegion label={label} className={className}>
    <div aria-hidden className="flex h-48 items-end gap-3 rounded-xl border border-border p-4">
      {["h-1/3", "h-2/3", "h-1/2", "h-4/5", "h-3/5", "h-full"].map((height, index) =>
        <SkeletonBar key={index} className={`min-w-0 flex-1 ${height}`} />)}
    </div>
  </SkeletonRegion>;
}

/** A statistic-shaped loading state; never presents a fake numeric value. */
export function SkeletonKpi({ label = "Loading statistics", className = "" }: { label?: string; className?: string }) {
  return <SkeletonRegion label={label} className={className}>
    <SkeletonCard className="space-y-3"><SkeletonBar className="h-3 w-24" /><SkeletonBar className="h-9 w-20" /><SkeletonBar className="h-3 w-32 max-w-full" /></SkeletonCard>
  </SkeletonRegion>;
}

/**
 * Wraps a skeleton so assistive tech hears one "Loading …" message
 * instead of a run of empty boxes.
 */
export function SkeletonRegion({
  label,
  className = "",
  children,
}: {
  /** Read out while loading, e.g. "Loading devices". */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
