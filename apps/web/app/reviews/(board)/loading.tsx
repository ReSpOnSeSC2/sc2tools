export default function ReviewsBoardLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading review board">
      <div className="space-y-2">
        <div className="h-3 w-40 animate-pulse rounded bg-bg-elevated" />
        <div className="h-8 w-64 animate-pulse rounded bg-bg-elevated" />
      </div>
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl border-2 border-line bg-bg-surface shadow-hard" />
        ))}
      </div>
    </div>
  );
}
