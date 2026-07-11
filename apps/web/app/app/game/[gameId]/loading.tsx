/**
 * Route-level skeleton for the per-game deep dive. Mirrors the real
 * layout — back link, header block, the timeline card, then the
 * two-column mechanics row — so the page doesn't flash blank while
 * the client bundle streams in.
 */
export default function GameDetailLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading game">
      <div className="h-4 w-40 animate-pulse rounded bg-bg-elevated" />
      <div className="space-y-2">
        <div className="h-8 w-72 animate-pulse rounded bg-bg-elevated" />
        <div className="h-4 w-96 max-w-full animate-pulse rounded bg-bg-elevated" />
      </div>

      <div className="rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard">
        <div className="h-64 animate-pulse rounded bg-bg-elevated" />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="space-y-3 rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard"
          >
            {Array.from({ length: 4 }).map((_, j) => (
              <div key={j} className="h-5 animate-pulse rounded bg-bg-elevated" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
