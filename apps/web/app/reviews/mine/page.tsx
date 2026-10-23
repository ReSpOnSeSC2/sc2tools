import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { MessageSquareText } from "lucide-react";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { PageHeader } from "@/components/ui/PageHeader";
import { MyReviews } from "@/components/reviews/MyReviews";
import { AskAboutGameButton } from "@/components/reviews/AskGamePicker";
import { reviewsRollout } from "@/lib/reviews";

/**
 * /reviews/mine — your requests, the reviews you wrote and your blocked
 * reviewers. Personal, so it's rendered client-side with your token and
 * never indexed. A static segment, so it wins over /reviews/[id].
 */

export const metadata: Metadata = {
  title: "My reviews",
  robots: { index: false, follow: false },
};

export default function MyReviewsPage() {
  if (reviewsRollout() === "off") notFound();
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<span className="inline-flex items-center gap-2"><MessageSquareText className="h-4 w-4" aria-hidden /> Replay Review Exchange</span>}
        title="My reviews"
        description="The replays you've asked about, the reviews you've written, and the reviewers you've blocked."
        actions={
          <>
            <Link href="/reviews" className="inline-flex min-h-[44px] items-center rounded-full border-2 border-line px-5 font-semibold text-text hover:bg-bg-elevated">
              Review board
            </Link>
            <AskAboutGameButton />
            <LazyHelpLink slug="replay-reviews" className="inline-flex min-h-11 items-center text-caption font-semibold">
              How it works
            </LazyHelpLink>
          </>
        }
      />
      <Suspense fallback={<div aria-busy="true" aria-label="Loading your reviews" className="h-64 animate-pulse rounded-xl bg-bg-elevated" />}><MyReviews /></Suspense>
    </div>
  );
}
