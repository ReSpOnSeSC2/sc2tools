import Link from "next/link";
import { boardQuery, type BoardFilters } from "@/lib/reviews";

export function ReviewBoardPagination({ filters, cursor, nextCursor }: { filters: BoardFilters; cursor?: string | null; nextCursor?: string | null }) {
  if (!cursor && !nextCursor) return null;
  return <nav aria-label="Review board pages" className="flex flex-wrap items-center gap-3">{cursor ? <><p className="text-caption text-text-muted">Showing older requests</p><Link href={`/reviews${boardQuery(filters)}`} rel="nofollow" className="inline-flex min-h-11 items-center rounded-full border-2 border-line px-4 text-caption font-semibold text-text">← Newest</Link></> : null}{nextCursor ? <Link href={`/reviews${boardQuery(filters, { cursor: nextCursor })}`} rel="nofollow" className="inline-flex min-h-11 items-center rounded-full border-2 border-line px-4 text-caption font-semibold text-text">Older requests →</Link> : null}</nav>;
}
