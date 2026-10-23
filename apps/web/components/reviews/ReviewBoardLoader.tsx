"use client";

import { useAuth } from "@clerk/nextjs";
import { usePublicApi } from "@/lib/usePublicApi";
import type { ReviewBoardResponse } from "@/lib/reviews";
import { ReviewCard } from "./ReviewCard";
import { CloudOff } from "lucide-react";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";

/** Admin-only rollout stage: the board loads with the admin's token. */
export function ReviewBoardLoader({ query }: { query: string }) {
  const { isLoaded } = useAuth();
  const req = usePublicApi<ReviewBoardResponse>(`/v1/reviews${query}`, { revalidateOnFocus: false }, { personalized: true });
  if (req.error && isLoaded) {
    if (req.error.status === 403 || req.error.status === 404) return <p className="text-body text-text-muted">Reviews are in an admin-only preview.</p>;
    return <EmptyStatePanel icon={<CloudOff className="h-5 w-5" aria-hidden />} title="Couldn't load the review board"
      description="The review service didn't respond. Nothing was lost."
      action={<Button variant="secondary" loading={req.isValidating} onClick={() => void req.mutate()}>Try again</Button>} />;
  }
  if (!req.data) return <div aria-busy="true" aria-label="Loading review requests" className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl border-2 border-line bg-bg-elevated" />)}</div>;
  const now = Date.now();
  return <ul className="space-y-3">{req.data.items.map((card) => <ReviewCard key={card.id} card={card} now={now} />)}</ul>;
}
