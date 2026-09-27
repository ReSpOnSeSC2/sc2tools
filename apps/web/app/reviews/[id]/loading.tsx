/**
 * Paints instantly while the server fetch runs (cold API starts).
 * ``generateMetadata`` raises real 404s before this boundary streams.
 */
export default function ReviewLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading replay review">
      <div className="h-4 w-28 animate-pulse rounded bg-bg-elevated" />
      <div className="space-y-3 rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard">
        <div className="h-5 w-24 animate-pulse rounded bg-bg-elevated" />
        <div className="h-8 w-3/4 animate-pulse rounded bg-bg-elevated" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-bg-elevated" />
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(340px,440px)]">
        <div className="h-[36vh] animate-pulse rounded-xl border-2 border-line bg-bg-elevated xl:h-[70vh]" />
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl border-2 border-line bg-bg-surface" />
          ))}
        </div>
      </div>
    </div>
  );
}
