import { Skeleton } from "@/components/ui/Card";

export default function PublicReplayAnalysisLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading shared replay analysis">
      <div className="h-64 animate-pulse rounded-xl border-2 border-line bg-bg-surface shadow-hard" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => <div key={index} className="h-24 animate-pulse rounded-xl border-2 border-line bg-bg-surface shadow-hard" />)}
      </div>
      <Skeleton rows={5} />
    </div>
  );
}
