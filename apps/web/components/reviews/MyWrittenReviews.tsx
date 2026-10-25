"use client";

import Link from "next/link";
import { useState } from "react";
import { CheckCircle2, Star, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { RequestError } from "@/components/ui/RequestError";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import type { MyReviewsResponse, WrittenReview } from "@/lib/reviews";
import { useReviewPages } from "./useReviewPages";

export function MyWrittenReviews({ summary, error, retry }: {
  summary?: MyReviewsResponse; error?: { status: number; message: string }; retry: () => unknown;
}) {
  const [sort, setSort] = useState<"new" | "top">("new");
  const initial = summary && sort === "new" ? { items: summary.answered, nextCursor: summary.answeredNextCursor ?? null } : undefined;
  const feed = useReviewPages<WrittenReview>(`/v1/me/reviews?section=answered&sort=${sort}&limit=20`, Boolean(summary), initial);
  const items = Array.from(new Map(feed.items.map((item) => [item.commentId, item])).values());
  return <section aria-labelledby="my-answers" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="my-answers" className="font-display text-h3 font-bold text-text">Reviews you&apos;ve written</h2>
      <SegmentedControl label="Sort your written reviews" value={sort} onChange={setSort} options={[{ value: "new", label: "Newest" }, { value: "top", label: "Most upvoted" }]} />
    </div>
    {error && !summary ? <RequestError error={error} onRetry={retry} /> : !summary || !feed.data ? feed.error
      ? <RequestError error={feed.error} onRetry={() => feed.mutate()} />
      : <div aria-busy="true" aria-label="Loading reviews you've written" className="space-y-2">{[0, 1].map((index) => <div key={index} className="h-20 animate-pulse rounded-xl border-2 border-line bg-bg-elevated" />)}</div>
      : items.length ? <ul className="space-y-2" aria-label="Reviews you've written">{items.map((item) => <li key={item.commentId}>
        <Link href={`${item.request.url}#comment-${item.commentId}`} className="block space-y-1 rounded-xl border-2 border-line bg-bg-surface p-3 hover:border-accent-cyan">
          <p className="line-clamp-1 text-caption text-text-muted">{item.request.matchup ? `[${item.request.matchup}] ` : ""}{item.request.question}</p>
          <p className="line-clamp-2 break-words text-body text-text">{item.snippet}</p>
          <p className="flex flex-wrap items-center gap-3 text-caption">
            {item.best ? <span className="inline-flex items-center gap-1 font-semibold text-success"><Star className="h-3.5 w-3.5" aria-hidden />Best review</span> : null}
            {item.helpful ? <span className="inline-flex items-center gap-1 font-semibold text-success"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden />Helpful</span> : null}
            <span className="inline-flex items-center gap-1 text-text-muted"><ThumbsUp className="h-3.5 w-3.5" aria-hidden />{item.upvotes} upvote{item.upvotes === 1 ? "" : "s"}</span>
          </p>
        </Link>
      </li>)}</ul> : <p className="text-body text-text-muted">{feed.hasMore ? "No visible reviews on this page. Load more to continue through your history." : <>None yet. <Link href="/reviews" className="inline-flex min-h-11 items-center font-semibold text-link underline">Browse requests</Link> you can help with.</>}</p>}
    {feed.error && feed.data ? <RequestError error={feed.error} onRetry={() => feed.mutate()} /> : null}
    {error && summary ? <RequestError error={error} onRetry={retry} /> : null}
    {feed.hasMore ? <Button variant="secondary" loading={feed.loadingMore} disabled={Boolean(feed.error)} onClick={() => { void feed.loadMore(); }}>Load more written reviews</Button> : null}
  </section>;
}
