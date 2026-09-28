"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { SearchX } from "lucide-react";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { usePublicApi } from "@/lib/usePublicApi";
import { reviewsRollout, type ReviewPageData } from "@/lib/reviews";
import { ReviewPage } from "./ReviewPage";

const ID_RE = /^[A-Za-z0-9_-]{16}$/;

/**
 * The /reviews/[id] 404. The server render reads anonymously, so a
 * request hidden pending moderation (or removed by a moderator) 404s
 * even for its asker and for admins. The status stays a real 404 for
 * crawlers and visitors; once Clerk reports a signed-in viewer this
 * retries with their token and shows the request if they may see it.
 */
export function ReviewNotFound({ id }: { id: string | null }) {
  const { isLoaded, isSignedIn } = useAuth();
  const eligible = Boolean(id && ID_RE.test(id) && reviewsRollout() !== "off" && isLoaded && isSignedIn);
  const req = usePublicApi<ReviewPageData>(
    eligible && id ? `/v1/reviews/${encodeURIComponent(id)}` : null,
    { revalidateOnFocus: false, shouldRetryOnError: false },
    { personalized: true },
  );
  if (req.data?.request) return <ReviewPage initial={req.data} />;
  if (eligible && !req.data && !req.error) {
    return <div aria-busy="true" aria-label="Loading review" className="h-64 animate-pulse rounded-xl border-2 border-line bg-bg-elevated" />;
  }
  return (
    <EmptyStatePanel
      size="lg"
      icon={<SearchX className="h-6 w-6" aria-hidden />}
      title="Review not found"
      description="It doesn't exist, was removed, or is hidden pending moderator review."
      action={<Link href="/reviews" className="font-semibold text-accent-cyan underline underline-offset-2">Browse replay reviews</Link>}
    />
  );
}
