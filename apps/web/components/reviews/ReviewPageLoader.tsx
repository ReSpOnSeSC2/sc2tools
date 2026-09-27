"use client";

import { useAuth } from "@clerk/nextjs";
import { SearchX } from "lucide-react";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { usePublicApi } from "@/lib/usePublicApi";
import type { ReviewPageData } from "@/lib/reviews";
import { ReviewPage } from "./ReviewPage";

/**
 * Admin-only rollout stage: the API hides reviews from everyone else,
 * so the page is fetched client-side with the admin's own token.
 */
export function ReviewPageLoader({ id }: { id: string }) {
  const { isLoaded } = useAuth();
  const req = usePublicApi<ReviewPageData>(`/v1/reviews/${encodeURIComponent(id)}`, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  }, { personalized: true });
  if (req.data?.request) return <ReviewPage initial={req.data} />;
  if (req.error && isLoaded) {
    return (
      <EmptyStatePanel
        size="lg"
        icon={<SearchX className="h-6 w-6" aria-hidden />}
        title="Review not found"
        description="It doesn't exist, was removed, or you don't have access yet."
      />
    );
  }
  return <div aria-busy="true" aria-label="Loading review" className="h-64 animate-pulse rounded-xl border-2 border-line bg-bg-elevated" />;
}
