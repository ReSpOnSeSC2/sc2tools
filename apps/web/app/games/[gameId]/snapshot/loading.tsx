import { Skeleton } from "@/components/ui/Card";

export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6 h-8 w-80 animate-pulse rounded bg-bg-elevated" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr_320px]">
        <div className="space-y-3">
          <Skeleton rows={5} />
        </div>
        <div className="space-y-4">
          <div className="h-32 animate-pulse rounded-xl bg-bg-elevated" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="h-56 animate-pulse rounded-xl bg-bg-elevated" />
            <div className="h-56 animate-pulse rounded-xl bg-bg-elevated" />
            <div className="h-56 animate-pulse rounded-xl bg-bg-elevated" />
            <div className="h-56 animate-pulse rounded-xl bg-bg-elevated" />
          </div>
        </div>
        <div className="space-y-3">
          <Skeleton rows={5} />
        </div>
      </div>
    </div>
  );
}
