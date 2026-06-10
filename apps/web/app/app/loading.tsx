/**
 * Dashboard loading skeleton. The dashboard page is a Server Component
 * that awaits /v1/me at render time — on a Render cold start that's
 * 3–5 seconds of what used to be a blank page, which reads as "the app
 * is broken" to a first-time visitor. This skeleton paints instantly
 * (App Router streams it while the fetch is in flight) and mirrors the
 * real layout: header row with title + sync line, a KPI strip, and the
 * main content card.
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading dashboard">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <div className="h-8 w-44 animate-pulse rounded bg-bg-elevated" />
          <div className="h-4 w-64 animate-pulse rounded bg-bg-elevated" />
        </div>
        <div className="h-11 w-40 animate-pulse self-start rounded-full border-2 border-line bg-bg-surface sm:self-auto" />
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
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

      <div className="rounded-xl border-2 border-line bg-bg-surface shadow-hard">
        <div className="divide-y divide-border">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex animate-pulse gap-4 p-4">
              <div className="h-4 w-32 rounded bg-bg-elevated" />
              <div className="h-4 w-12 rounded bg-bg-elevated" />
              <div className="h-4 w-12 rounded bg-bg-elevated" />
              <div className="h-4 w-24 rounded bg-bg-elevated" />
              <div className="ml-auto h-4 w-16 rounded bg-bg-elevated" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
