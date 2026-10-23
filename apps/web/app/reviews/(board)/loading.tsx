export default function ReviewsBoardLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading review board">
      <div className="space-y-2">
        <div className="h-3 w-40 animate-pulse rounded bg-bg-elevated" />
        <div className="h-8 w-64 animate-pulse rounded bg-bg-elevated" />
      </div>
      <div className="flex flex-wrap gap-2">{[0, 1, 2, 3].map((item) => <div key={item} className="h-11 w-28 animate-pulse rounded-full bg-bg-elevated" />)}</div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]"><div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl border-2 border-line bg-bg-surface shadow-hard" />
        ))}
      </div><div className="h-fit space-y-3 rounded-xl border-2 border-line bg-bg-surface p-4"><div className="h-5 w-40 animate-pulse rounded bg-bg-elevated" />{[0, 1, 2, 3, 4].map((item) => <div key={item} className="h-12 animate-pulse rounded bg-bg-elevated" />)}</div></div>
    </div>
  );
}
