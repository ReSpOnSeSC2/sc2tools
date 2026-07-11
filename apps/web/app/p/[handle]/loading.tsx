/**
 * Player-page loading skeleton. The page is a Server Component that
 * awaits the public-profile API at render time; on a cold cache that's a
 * couple of seconds of what would otherwise be a blank page for a
 * first-time visitor arriving from a shared link. This skeleton streams
 * instantly and mirrors the real layout: hero banner, KPI strip, and the
 * two-column content grid.
 */
export default function PublicProfileLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading player profile">
      <div className="rounded-xl border-2 border-accent bg-bg-surface px-5 py-6 shadow-hard sm:px-6 sm:py-8">
        <div className="space-y-3">
          <div className="h-3 w-28 animate-pulse rounded bg-bg-elevated" />
          <div className="h-9 w-56 animate-pulse rounded bg-bg-elevated" />
          <div className="h-4 w-72 animate-pulse rounded bg-bg-elevated" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard"
          >
            <div className="h-3 w-16 animate-pulse rounded bg-bg-elevated" />
            <div className="mt-2 h-6 w-20 animate-pulse rounded bg-bg-elevated" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard"
          >
            <div className="h-3 w-24 animate-pulse rounded bg-bg-elevated" />
            <div className="mt-4 space-y-3">
              {Array.from({ length: 4 }).map((_, j) => (
                <div key={j} className="space-y-1.5">
                  <div className="h-4 w-full animate-pulse rounded bg-bg-elevated" />
                  <div className="h-1.5 w-full animate-pulse rounded bg-bg-elevated" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
