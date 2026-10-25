import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CloudOff, MessageSquareText } from "lucide-react";
import { SignedIn, SignedOut } from "@clerk/nextjs";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { ReviewCard } from "@/components/reviews/ReviewCard";
import { ReviewBoardFilters } from "@/components/reviews/ReviewBoardFilters";
import { HelpWithPanel, ReviewLeaderboard } from "@/components/reviews/ReviewBoardSidebar";
import { ActiveFilterChips } from "@/components/reviews/ActiveFilterChips";
import { AskAboutGameButton } from "@/components/reviews/AskGamePicker";
import { ReviewBoardEmpty } from "@/components/reviews/ReviewBoardEmpty";
import { ReviewBoardPagination } from "@/components/reviews/ReviewBoardPagination";
import { ReviewBoardLoader } from "@/components/reviews/ReviewBoardLoader";
import { ReviewExchangeIntro } from "@/components/reviews/ReviewExchangeIntro";
import { getJsonWithStatus } from "@/lib/serverApi";
import {
  boardQuery,
  parseBoardFilters,
  reviewsRollout,
  type LeaderboardResponse,
  type ReviewBoardResponse,
} from "@/lib/reviews";
import { siteTitle } from "@/lib/siteTitle";

/**
 * /reviews — the public Review Board. Server-rendered from the public,
 * unpersonalised board API (Cache-Control s-maxage=60) so every filtered
 * view is a crawlable page; the personalised "Requests you can help
 * with" list and the leaderboard opt-in hydrate client-side. Signed-out
 * visitors also get the three-step "How the Review Exchange works"
 * strip with the sign-up CTA.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const rollout = reviewsRollout();
  if (rollout === "off") notFound();
  const filters = parseBoardFilters(await searchParams);
  const scope = filters.matchup ? `${filters.matchup} ` : filters.race ? `${{ P: "Protoss", T: "Terran", Z: "Zerg" }[filters.race]} ` : "";
  const title = `${scope}Replay reviews — ask about any moment of your game`;
  const description = `Post a StarCraft II ${scope}replay with a question and get answers pinned to exact moments on the replay timeline and map, from players whose league is verified from their own games.`;
  return {
    title,
    description,
    alternates: { canonical: `/reviews${boardQuery({ ...filters, sort: "hot", band: filters.band, tag: filters.tag, unanswered: false })}` },
    robots: rollout === "on" ? { index: true, follow: true } : { index: false, follow: false },
    // Social cards get no title template, so they carry the brand themselves.
    openGraph: { title: siteTitle(title), description, url: "/reviews", images: [{ url: "/og.jpg", width: 1200, height: 630, alt: siteTitle(title) }] },
    twitter: { card: "summary_large_image", title: siteTitle(title), description, images: ["/og.jpg"] },
  };
}

export default async function ReviewsBoardPage({ searchParams }: { searchParams: SearchParams }) {
  const rollout = reviewsRollout();
  if (rollout === "off") notFound();
  const sp = await searchParams;
  const filters = parseBoardFilters(sp);
  const cursor = typeof sp.cursor === "string" && sp.cursor.length <= 300 ? sp.cursor : null;
  const header = (
    <PageHeader
      eyebrow={<span className="inline-flex items-center gap-2"><MessageSquareText className="h-4 w-4" aria-hidden /> Replay Review Exchange</span>}
      title="Replay reviews"
      description="Players post a game with a question; reviewers answer with comments pinned to exact moments on the replay and the map. Reviewer leagues are verified from their own synced games."
      actions={
        <>
          {/* Outside SignedIn: visitors deciding whether to sign up need it most. */}
          <LazyHelpLink slug="replay-reviews" className="inline-flex min-h-11 items-center text-caption font-semibold">
            How it works
          </LazyHelpLink>
          <SignedIn>
            <Link href="/reviews/mine" className="inline-flex min-h-[44px] items-center rounded-full border-2 border-line px-5 font-semibold text-text hover:bg-bg-elevated">
              My reviews
            </Link>
            <AskAboutGameButton />
            <LazyHelpLink
              slug="replay-reviews"
              anchor="asking-for-a-review"
              className="inline-flex min-h-11 items-center text-caption font-semibold"
            >
              How to ask
            </LazyHelpLink>
          </SignedIn>
        </>
      }
    />
  );
  const adminStage = rollout === "admins";
  const [board, leaderboard] = await Promise.all([
    adminStage ? Promise.resolve({ data: null }) : getJsonWithStatus<ReviewBoardResponse>(`/v1/reviews${boardQuery(filters, cursor ? { cursor } : {})}`, { revalidateSec: 60 }),
    adminStage ? Promise.resolve({ data: null }) : getJsonWithStatus<LeaderboardResponse>("/v1/reviews/leaderboard", { revalidateSec: 60 }),
  ]);
  const now = Date.now();
  const items = board.data?.items ?? [];
  return (
    <div className="space-y-6">
      {header}
      <SignedOut>
        <ReviewExchangeIntro />
      </SignedOut>
      <ReviewBoardFilters filters={filters} />
      <ActiveFilterChips filters={filters} />
      <SignedIn><HelpWithPanel now={now} placement="inline" /></SignedIn>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          {adminStage ? <ReviewBoardLoader query={boardQuery(filters)} cursor={cursor} /> : !board.data ? (
            <EmptyStatePanel
              icon={<CloudOff className="h-6 w-6" aria-hidden />}
              title="The review board is temporarily unavailable"
              description="The review service didn't respond. Try again in a moment."
            />
          ) : items.length === 0 ? (
            <ReviewBoardEmpty filters={filters} />
          ) : (
            <ul className="space-y-3" aria-label="Review requests">
              {items.map((card) => <ReviewCard key={card.id} card={card} now={now} />)}
            </ul>
          )}
          {!adminStage ? <ReviewBoardPagination filters={filters} cursor={cursor} nextCursor={board.data?.nextCursor} /> : null}
        </div>
        <aside className="min-w-0 space-y-6">
          <SignedIn>
            <HelpWithPanel now={now} placement="aside" />
          </SignedIn>
          <ReviewLeaderboard initial={leaderboard.data} />
        </aside>
      </div>
    </div>
  );
}
