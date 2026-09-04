/**
 * Today loading skeleton — streams inside the app chrome during /app
 * page transitions, mirroring TodayView's stack: KPI strip, Daily
 * Pulse strip, Ladder Pulse card. (The cold-start skeleton for the
 * whole shell lives in app/app/layout.tsx.)
 */
export default function TodayLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading Today">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard"
          >
            <div className="h-3 w-16 animate-pulse rounded bg-bg-elevated" />
            <div className="mt-2 h-6 w-20 animate-pulse rounded bg-bg-elevated" />
          </div>
        ))}
      </div>
      <div className="h-32 animate-pulse rounded-xl border-2 border-line bg-bg-surface shadow-hard" />
      <div className="h-40 animate-pulse rounded-xl border-2 border-line bg-bg-surface shadow-hard" />
    </div>
  );
}
