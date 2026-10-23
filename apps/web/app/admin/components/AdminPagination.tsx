import { Button } from "@/components/ui/Button";

export function AdminPagination({ hasPrev, hasNext, onPrev, onNext, label, loading = false, itemCount, prevLabel = "Previous" }: {
  hasPrev: boolean; hasNext: boolean; onPrev: () => void; onNext: () => void;
  label: string; loading?: boolean; itemCount: number; prevLabel?: string;
}) {
  if (!itemCount && !hasPrev) return null;
  return <nav aria-label="Pagination" className="flex items-center justify-between gap-3">
    <Button variant="secondary" size="sm" disabled={!hasPrev || loading} onClick={onPrev}>{prevLabel}</Button>
    <span className="text-caption text-text-dim" aria-live="polite">{label}</span>
    <Button variant="secondary" size="sm" disabled={!hasNext} loading={loading} onClick={onNext}>Next</Button>
  </nav>;
}
