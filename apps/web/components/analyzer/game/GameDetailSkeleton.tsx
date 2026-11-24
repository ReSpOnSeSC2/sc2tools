export function GameDetailSkeleton() {
  return <div className="space-y-6" aria-busy="true" aria-label="Loading game">
    <span className="sr-only">Loading game</span>
    <div className="skeleton-shimmer h-4 w-40 rounded-full" />
    <div className="skeleton-shimmer h-40 rounded-2xl" />
    <div className="skeleton-shimmer h-11 w-full max-w-xl rounded-full" />
    <div className="skeleton-shimmer h-64 rounded-2xl" />
    <div className="skeleton-shimmer h-[52vh] max-h-[36rem] rounded-2xl xl:h-[min(88vh,1040px)]" />
    <div className="grid gap-6 md:grid-cols-2">{[0, 1].map((i) => <div key={i} className="skeleton-shimmer h-48 rounded-2xl" />)}</div>
  </div>;
}
