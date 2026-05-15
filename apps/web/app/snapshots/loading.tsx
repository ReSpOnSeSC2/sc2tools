import { Skeleton } from "@/components/ui/Card";

export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6 h-8 w-64 animate-pulse rounded bg-bg-elevated" />
      <Skeleton rows={6} />
    </div>
  );
}
