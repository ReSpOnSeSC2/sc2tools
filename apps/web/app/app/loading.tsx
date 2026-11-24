/**
 * Today loading skeleton — streams inside the app chrome during /app
 * page transitions, mirroring TodayView's stack: KPI strip, Daily
 * Pulse strip, Ladder Pulse card. (The cold-start skeleton for the
 * whole shell lives in app/app/layout.tsx.)
 */
export default function TodayLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading Today">
      {/* Same grid as DashboardKpiStrip: the lead card spans both
          columns on phones, so nothing shifts when the cards arrive. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className={[
              "rounded-2xl border border-line bg-bg-surface surface-sheen p-4 shadow-card",
              i === 0 ? "col-span-2 lg:col-span-1" : "",
            ].join(" ")}
          >
            <div className="skeleton-shimmer h-3 w-16 rounded-full" />
            <div className="skeleton-shimmer mt-3 h-8 w-24 rounded-lg" />
          </div>
        ))}
      </div>
      <div className="skeleton-shimmer h-32 rounded-2xl border border-line" />
      <div className="skeleton-shimmer h-40 rounded-2xl border border-line" />
    </div>
  );
}
