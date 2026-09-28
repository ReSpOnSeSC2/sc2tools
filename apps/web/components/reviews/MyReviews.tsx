"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { CheckCircle2, MessageSquareText, ShieldOff, Star, ThumbsUp } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { apiCall, useApi } from "@/lib/clientApi";
import type { MyReviewsResponse, ReviewBlocksResponse } from "@/lib/reviews";
import { ReviewCard } from "./ReviewCard";

/**
 * /reviews/mine — the signed-in player's own corner of the exchange: the
 * requests they asked (with status, including "hidden pending review"),
 * the reviews they wrote on other people's requests, and the reviewers
 * they blocked (the only place to undo a block).
 */
// How long to show a skeleton while Clerk loads before assuming "signed
// out". Clerk never finishes loading when its script is blocked (ad
// blockers), so waiting on ``isLoaded`` alone could spin forever.
const AUTH_GRACE_MS = 1500;

export function MyReviews() {
  const { isLoaded, isSignedIn } = useAuth();
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setGraceOver(true), AUTH_GRACE_MS);
    return () => clearTimeout(timer);
  }, []);
  if (isLoaded && isSignedIn) return <MyReviewsSignedIn />;
  if (!isLoaded && !graceOver) {
    return <div aria-busy="true" aria-label="Loading your reviews" className="h-64 animate-pulse rounded-xl border-2 border-line bg-bg-elevated" />;
  }
  return (
    <EmptyStatePanel
      size="lg"
      icon={<MessageSquareText className="h-6 w-6" aria-hidden />}
      title="Sign in to see your reviews"
      description="Your review requests, the reviews you've written and the reviewers you've blocked live here."
      action={
        <Link href={`/sign-in?redirect_url=${encodeURIComponent("/reviews/mine")}`} className="font-semibold text-accent-cyan underline underline-offset-2">
          Sign in
        </Link>
      }
    />
  );
}

function MyReviewsSignedIn() {
  const mine = useApi<MyReviewsResponse>("/v1/me/reviews", { revalidateOnFocus: true });
  const now = Date.now();
  if (mine.error?.status === 404) {
    return (
      <EmptyStatePanel
        title="Your reviews couldn't be loaded"
        description="The Replay Review Exchange isn't available on your account yet."
      />
    );
  }
  const asked = mine.data?.asked ?? [];
  const answered = mine.data?.answered ?? [];
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-6">
        <section aria-labelledby="my-requests" className="space-y-3">
          <h2 id="my-requests" className="font-display text-h3 font-bold text-text">Your review requests</h2>
          {mine.error ? (
            <p role="status" className="text-body text-text-muted">Your requests couldn&apos;t be loaded. Try again in a moment.</p>
          ) : !mine.data ? (
            <div aria-busy="true" className="h-28 animate-pulse rounded-xl border-2 border-line bg-bg-elevated" />
          ) : asked.length === 0 ? (
            <EmptyStatePanel
              title="You haven't asked for a review yet"
              description="Open one of your 1v1 games and use “Ask for a review”."
              action={<Link href="/app" className="font-semibold text-accent-cyan underline underline-offset-2">Go to your games</Link>}
            />
          ) : (
            <ul className="space-y-3" aria-label="Your review requests">
              {asked.map((card) => <ReviewCard key={card.id} card={card} now={now} />)}
            </ul>
          )}
        </section>

        <section aria-labelledby="my-answers" className="space-y-3">
          <h2 id="my-answers" className="font-display text-h3 font-bold text-text">Reviews you've written</h2>
          {!mine.data ? null : answered.length === 0 ? (
            <p className="text-body text-text-muted">
              None yet. <Link href="/reviews" className="font-semibold text-accent-cyan underline underline-offset-2">Browse requests</Link> you can help with.
            </p>
          ) : (
            <ul className="space-y-2" aria-label="Reviews you've written">
              {answered.map((a) => (
                <li key={a.commentId}>
                  <Link
                    href={`${a.request.url}#comment-${a.commentId}`}
                    className="block space-y-1 rounded-xl border-2 border-line bg-bg-surface p-3 hover:border-accent-cyan"
                  >
                    <p className="line-clamp-1 text-caption text-text-muted">
                      {a.request.matchup ? `[${a.request.matchup}] ` : ""}{a.request.question}
                    </p>
                    <p className="line-clamp-2 break-words text-body text-text">{a.snippet}</p>
                    <p className="flex flex-wrap items-center gap-3 text-caption">
                      {a.best ? <span className="inline-flex items-center gap-1 font-semibold text-success"><Star className="h-3.5 w-3.5" aria-hidden /> Best review</span> : null}
                      {a.helpful ? <span className="inline-flex items-center gap-1 font-semibold text-success"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Helpful</span> : null}
                      <span className="inline-flex items-center gap-1 text-text-muted"><ThumbsUp className="h-3.5 w-3.5" aria-hidden /> {a.upvotes}</span>
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <aside className="min-w-0">
        <BlockedReviewers />
      </aside>
    </div>
  );
}

function BlockedReviewers() {
  const { getToken } = useAuth();
  const blocks = useApi<ReviewBlocksResponse>("/v1/me/review-blocks");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function unblock(id: string, name: string) {
    setBusyId(id);
    setNotice(null);
    try {
      await apiCall(getToken, `/v1/me/review-blocks/${encodeURIComponent(id)}`, { method: "DELETE" });
      setNotice(`Unblocked ${name}.`);
    } catch (err) {
      setNotice((err as { message?: string })?.message || "Couldn't unblock right now.");
    } finally {
      // Always resync, so a block already removed elsewhere drops off.
      await blocks.mutate();
      setBusyId(null);
    }
  }

  const items = blocks.data?.items ?? [];
  return (
    <Card title="Blocked reviewers" right={<ShieldOff className="h-4 w-4 text-text-muted" aria-hidden />}>
      {blocks.error ? (
        <p className="text-caption text-text-muted">Your blocks couldn't be loaded.</p>
      ) : !blocks.data ? (
        <div aria-busy="true" className="h-16 animate-pulse rounded-lg bg-bg-elevated" />
      ) : items.length === 0 ? (
        <p className="text-caption text-text-muted">You haven&apos;t blocked anyone. Block a reviewer from the ⋯ menu on one of their comments.</p>
      ) : (
        <ul className="space-y-2" aria-label="Blocked reviewers">
          {items.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-body text-text">{b.name}</span>
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => void unblock(b.id, b.name)}
                className="min-h-[36px] shrink-0 rounded-full border-2 border-line px-3 text-caption font-semibold text-text hover:bg-bg-elevated disabled:opacity-60"
              >
                {busyId === b.id ? "Unblocking…" : "Unblock"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {notice ? <p role="status" className="mt-2 text-caption text-text-muted">{notice}</p> : null}
    </Card>
  );
}
