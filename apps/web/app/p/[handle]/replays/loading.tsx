import { Skeleton } from "@/components/ui/Card";

export default function PublicReplaysLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading shared replay archive">
      <div className="h-44 animate-pulse rounded-xl border-2 border-line bg-bg-surface shadow-hard" />
      <Skeleton rows={7} />
    </div>
  );
}
