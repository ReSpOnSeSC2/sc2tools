import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CloudOff } from "lucide-react";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { ReviewPage } from "@/components/reviews/ReviewPage";
import { ReviewPageLoader } from "@/components/reviews/ReviewPageLoader";
import { getJsonWithStatus } from "@/lib/serverApi";
import { reviewJsonLd, serializeJsonLd } from "@/lib/reviewJsonLd";
import { reviewHeadline, reviewPageTitle, reviewsRollout, type ReviewPageData } from "@/lib/reviews";

/**
 * /reviews/[id] — a public, server-rendered replay review.
 *
 * Deliberately OUTSIDE the auth middleware: the asker opted in, and the
 * API serves only the redacted request + the request's scoped grant.
 * Signing in is needed only to comment, vote or mark helpful.
 *
 * SEO: canonical /reviews/<id>; indexable only once the thread has a
 * helpful or best review (quality gate, decided by the API), with
 * QAPage + BreadcrumbList JSON-LD. Link-only requests are never indexed.
 * No loading boundary sits above this page (the board's lives in the
 * ``(board)`` route group) so a missing review is a real 404 status for
 * every user agent, not a streamed soft-404. Only an API 404 is a 404:
 * an unreachable API, a rate limit or a 5xx renders "unavailable" +
 * noindex. The server read is anonymous, so a hidden or removed request
 * 404s here even for its asker and admins; ``not-found.tsx`` retries
 * with their token on the client.
 */

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://sc2tools.com";

type Params = { params: Promise<{ id: string }> };

const ID_RE = /^[A-Za-z0-9_-]{16}$/;

async function fetchReview(id: string) {
  if (!ID_RE.test(id)) return { data: null, status: 404 };
  return getJsonWithStatus<ReviewPageData>(`/v1/reviews/${encodeURIComponent(id)}`, { revalidateSec: 30 });
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const rollout = reviewsRollout();
  if (rollout === "off") notFound();
  const canonical = `/reviews/${id}`;
  if (rollout === "admins") {
    return { title: "Replay review · SC2 Tools", robots: { index: false, follow: false }, alternates: { canonical } };
  }
  const { data, status } = await fetchReview(id);
  if (!data?.request) {
    if (status === 404) notFound();
    return {
      title: "Replay review · SC2 Tools",
      description: "This replay review is temporarily unavailable.",
      robots: { index: false, follow: false },
      alternates: { canonical },
    };
  }
  const r = data.request;
  const title = reviewPageTitle(r.question, r.game.matchup);
  const count = r.stats.reviewCount;
  const description = `${reviewHeadline(r.question, r.game.matchup)} — ${count === 1 ? "1 timestamped review" : `${count} timestamped reviews`} on ${r.game.map ?? "the replay"}. Asked by ${r.asker.label}${r.asker.band ? ` (${r.asker.band.label})` : ""}.`.slice(0, 300);
  return {
    title,
    description,
    alternates: { canonical },
    robots: data.seo.indexable
      ? { index: true, follow: true }
      : { index: false, follow: r.visibility === "public" },
    openGraph: { type: "article", title, description, url: `${SITE_URL}${canonical}` },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function ReviewRoute({ params }: Params) {
  const { id } = await params;
  const rollout = reviewsRollout();
  if (rollout === "off") notFound();
  // Admin-only stage: the API 404s anonymous reads, so the page loads
  // client-side with the admin's token instead of server-rendering.
  if (rollout === "admins") return <ReviewPageLoader id={id} />;
  const { data, status } = await fetchReview(id);
  if (!data?.request) {
    if (status === 404) notFound();
    return (
      <EmptyStatePanel
        size="lg"
        icon={<CloudOff className="h-6 w-6" aria-hidden />}
        title="This replay review is temporarily unavailable"
        description="The review service didn't respond. Try again in a moment."
      />
    );
  }
  return (
    <>
      {data.seo.indexable ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(reviewJsonLd(data, SITE_URL)) }}
        />
      ) : null}
      <ReviewPage initial={data} />
    </>
  );
}
