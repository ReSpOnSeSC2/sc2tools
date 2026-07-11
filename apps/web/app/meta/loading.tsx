/**
 * Ladder Meta Radar loading skeleton. The page is a Server Component that
 * awaits GET /v1/meta/ladder at render time; on a Render cold start that's
 * a few seconds of otherwise-blank page. This paints instantly (the App
 * Router streams it while the fetch is in flight) and mirrors the real
 * layout: header, the picker row, and the ranked report card.
 */
export default function MetaLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading ladder meta">
      <header className="space-y-2">
        <div className="h-3 w-32 animate-pulse rounded bg-bg-elevated" />
        <div className="h-9 w-72 animate-pulse rounded bg-bg-elevated" />
        <div className="h-4 w-full max-w-xl animate-pulse rounded bg-bg-elevated" />
      </header>

      <div className="flex flex-wrap gap-3">
        <div className="h-10 w-40 animate-pulse rounded-lg bg-bg-elevated" />
        <div className="h-10 w-28 animate-pulse rounded-lg bg-bg-elevated" />
      </div>

      <div className="rounded-xl border-2 border-line bg-bg-surface shadow-hard">
        <div className="divide-y divide-border">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex animate-pulse items-center gap-4 p-4">
              <div className="h-4 w-40 rounded bg-bg-elevated" />
              <div className="ml-auto h-4 w-12 rounded bg-bg-elevated" />
              <div className="h-4 w-12 rounded bg-bg-elevated" />
              <div className="h-4 w-16 rounded bg-bg-elevated" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
