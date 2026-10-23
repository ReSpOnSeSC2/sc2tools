export function GameDetailSkeleton() {
  return <div className="space-y-6" aria-busy="true" aria-label="Loading game">
    <span className="sr-only">Loading game</span>
    <div className="h-4 w-40 animate-pulse rounded bg-bg-elevated" />
    <div className="h-40 animate-pulse rounded-xl bg-bg-elevated" />
    <div className="h-64 animate-pulse rounded-xl bg-bg-elevated" />
    <div className="h-[52vh] max-h-[36rem] animate-pulse rounded-xl bg-bg-elevated xl:h-[min(88vh,1040px)]" />
    <div className="grid gap-6 md:grid-cols-2">{[0, 1].map((i) => <div key={i} className="h-48 animate-pulse rounded-xl bg-bg-elevated" />)}</div>
  </div>;
}
