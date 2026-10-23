"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { RequestError } from "@/components/ui/RequestError";
import { Tabs } from "@/components/ui/Tabs";
import type { MyReviewsResponse, MyReviewTab, ReviewCard as CardData } from "@/lib/reviews";
import { AskAboutGameButton } from "./AskGamePicker";
import { ReviewCard } from "./ReviewCard";
import { useReviewPages } from "./useReviewPages";

const TABS: readonly { value: MyReviewTab; label: string; empty: string; detail: string }[] = [
  { value: "needs", label: "Needs your response", empty: "No reviews need your response", detail: "When reviews arrive on an open request, mark the ones that helped you or choose the best answer." },
  { value: "waiting", label: "Waiting for reviews", empty: "Nothing waiting: every open request has at least one review.", detail: "New requests without any reviews appear here." },
  { value: "answered", label: "Answered", empty: "No best answers chosen yet", detail: "A request is answered when you choose its best review. Helpful marks alone leave it open." },
  { value: "closed", label: "Closed", empty: "No closed requests", detail: "Requests you close stay here with their comments; they stop accepting new comments." },
  { value: "all", label: "All", empty: "You haven't asked for a review yet", detail: "Pick one of your synced 1v1 games and ask about the moment you want help with." },
];

export function MyReviewRequests({ summary, error, retry }: {
  summary?: MyReviewsResponse; error?: { status: number; message: string }; retry: () => unknown;
}) {
  const params = useSearchParams();
  const requested = params.get("tab");
  const tab = TABS.find((item) => item.value === requested)?.value ?? (summary?.counts?.needs ? "needs" : "all");
  const selected = TABS.find((item) => item.value === tab)!;
  const initial = summary && tab === "all" ? { items: summary.asked, nextCursor: summary.askedNextCursor ?? null } : undefined;
  const feed = useReviewPages<CardData>(`/v1/me/reviews?section=asked&tab=${tab}&limit=20`, Boolean(summary), initial);
  const items = Array.from(new Map(feed.items.map((item) => [item.id, item])).values());
  const choose = (value: string) => {
    const next = new URLSearchParams(window.location.search); next.set("tab", value);
    window.history.replaceState(null, "", `${window.location.pathname}?${next}${window.location.hash}`);
  };
  useEffect(() => { if (summary && requested !== tab) choose(tab); }, [summary, requested, tab]);
  return <section aria-labelledby="my-requests" className="space-y-3">
    <h2 id="my-requests" className="font-display text-h3 font-bold text-text">Your review requests</h2>
    <Tabs value={tab} onValueChange={choose}>
      <Tabs.List ariaLabel="Your request status">{TABS.map((item) => <Tabs.Trigger key={item.value} value={item.value}>
        {item.label}{summary?.counts ? ` (${summary.counts[item.value]})` : ""}
      </Tabs.Trigger>)}</Tabs.List>
      {TABS.map((item) => <Tabs.Content key={item.value} value={item.value}>
        {tab === item.value ? <>
          <p className="mb-3 text-caption text-text-muted">{selected.detail}</p>
          {error && !summary ? <RequestError error={error} onRetry={retry} /> : !summary || !feed.data ? feed.error
            ? <RequestError error={feed.error} onRetry={() => feed.mutate()} />
            : <div aria-busy="true" aria-label="Loading your review requests" className="h-28 animate-pulse rounded-xl border-2 border-line bg-bg-elevated" />
            : items.length ? <ul className="space-y-3" aria-label="Your review requests">{items.map((card) => <ReviewCard key={card.id} card={card} now={Date.now()} />)}</ul>
              : <EmptyStatePanel title={selected.empty} description={selected.detail} action={tab === "all"
                ? <div className="flex flex-wrap justify-center gap-3"><AskAboutGameButton /><Link href="/app/replays" className="inline-flex min-h-11 items-center font-semibold text-link underline">Browse your replays</Link></div> : undefined} />}
          {feed.error && feed.data ? <RequestError error={feed.error} onRetry={() => feed.mutate()} /> : null}
          {error && summary ? <RequestError error={error} onRetry={retry} /> : null}
          {feed.hasMore ? <Button className="mt-3" variant="secondary" loading={feed.loadingMore} disabled={Boolean(feed.error)} onClick={() => { void feed.loadMore(); }}>Load more requests</Button> : null}
        </> : null}
      </Tabs.Content>)}
    </Tabs>
  </section>;
}
