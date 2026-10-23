"use client";

import { Button } from "@/components/ui/Button";

interface BuildPaginationProps {
  pageNumber: number;
  pageSize?: number;
  pageStart: number;
  count: number;
  total?: number | null;
  hasPrevious: boolean;
  hasNext: boolean;
  loading?: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

export function BuildPagination({ pageNumber, pageSize = 50, pageStart, count, total, hasPrevious, hasNext, loading, onPrevious, onNext }: BuildPaginationProps) {
  if (!hasPrevious && !hasNext) return null;
  return (
    <nav aria-label="Custom build pages" className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <p className="text-caption text-text-muted" aria-live="polite">
        {count > 0
          ? `Page ${pageNumber}${total != null ? ` of ${Math.ceil(total / pageSize)}` : ""} · builds ${(pageStart + 1).toLocaleString()}–${(pageStart + count).toLocaleString()}${total != null ? ` of ${total.toLocaleString()}` : ""}`
          : `Page ${pageNumber}`}
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={!hasPrevious} onClick={onPrevious}>Previous</Button>
        <Button variant="secondary" size="sm" disabled={!hasNext || loading} onClick={onNext}>Next</Button>
      </div>
    </nav>
  );
}
