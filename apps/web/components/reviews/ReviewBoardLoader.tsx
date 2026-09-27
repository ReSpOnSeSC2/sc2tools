"use client";

import { useAuth } from "@clerk/nextjs";
import { usePublicApi } from "@/lib/usePublicApi";
import type { ReviewBoardResponse } from "@/lib/reviews";
import { ReviewCard } from "./ReviewCard";

/** Admin-only rollout stage: the board loads with the admin's token. */
export function ReviewBoardLoader({ query }: { query: string }) {
  const { isLoaded } = useAuth();
  const req = usePublicApi<ReviewBoardResponse>(`/v1/reviews${query}`, { revalidateOnFocus: false }, { personalized: true });
  if (req.error && isLoaded) return <p className="text-body text-text-muted">Reviews are in an admin-only preview.</p>;
  if (!req.data) return <div aria-busy="true" className="h-40 animate-pulse rounded-xl bg-bg-elevated" />;
  const now = Date.now();
  return <ul className="space-y-3">{req.data.items.map((card) => <ReviewCard key={card.id} card={card} now={now} />)}</ul>;
}
