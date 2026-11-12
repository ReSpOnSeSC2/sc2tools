export function PracticeLinkLoading() {
  return <div role="status" className="mx-auto max-w-5xl space-y-5">
    <span className="sr-only">Loading Practice Link…</span>
    <div aria-hidden className="space-y-3 motion-safe:animate-pulse">
      <div className="h-8 w-2/3 rounded bg-bg-elevated" />
      <div className="h-5 w-1/2 rounded bg-bg-elevated" />
      <div className="aspect-video min-h-[200px] rounded-xl bg-bg-elevated" />
    </div>
  </div>;
}
