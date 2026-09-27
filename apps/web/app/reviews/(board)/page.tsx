import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CloudOff, MessageSquareText } from "lucide-react";
import { SignedIn } from "@clerk/nextjs";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { ReviewCard } from "@/components/reviews/ReviewCard";
import { ReviewBoardFilters } from "@/components/reviews/ReviewBoardFilters";
import { HelpWithList, ReviewLeaderboard } from "@/components/reviews/ReviewBoardSidebar";
import { ReviewBoardLoader } from "@/components/reviews/ReviewBoardLoader";
import { getJsonWithStatus } from "@/lib/serverApi";
import {
  boardQuery,
  parseBoardFilters,
  reviewsRollout,
  type LeaderboardResponse,
  type ReviewBoardResponse,
} from "@/lib/reviews";

/**
 * /reviews — the public Review Board. Server-rendered from the public,
 * unpersonalised board API (Cache-Control s-maxage=60) so every filtered
 * view is a crawlable page; the personalised "Requests you can help
 * with" list and the leaderboard opt-in hydrate client-side.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const rollout = reviewsRollout();
  if (rollout === "off") notFound();
  const filters = parseBoardFilters(await searchParams);
  const scope = filters.matchup ? `${filters.matchup} ` : "";
  const title = `${scope}Replay reviews — ask about any moment of your game · SC2 Tools`;
  const description = `Post a StarCraft II ${scope}replay with a question and get answers pinned to exact moments on the replay timeline and map, from players whose league is verified from their own games.`;
  return {
    title,
    description,
    alternates: { canonical: `/reviews${boardQuery({ ...filters, sort: "hot", band: filters.band, tag: filters.tag, unanswered: false })}` },
    robots: rollout === "on" ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: { title, description, url: "/reviews" },
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
        <SignedIn>
          <Link href="/app" className="hard-press inline-flex min-h-[44px] items-center rounded-full border-2 border-line bg-accent px-5 font-display text-body font-bold text-white hover:bg-accent-hover">
            Ask about one of your games
          </Link>
        </SignedIn>
      }
    />
  );
  if (rollout === "admins") {
    return (
      <div className="space-y-6">
        {header}
        <ReviewBoardLoader query={boardQuery(filters)} />
      </div>
    );
  }
  const [board, leaderboard] = await Promise.all([
    getJsonWithStatus<ReviewBoardResponse>(`/v1/reviews${boardQuery(filters, cursor ? { cursor } : {})}`, { revalidateSec: 60 }),
    getJsonWithStatus<LeaderboardResponse>("/v1/reviews/leaderboard", { revalidateSec: 60 }),
  ]);
  const now = Date.now();
  const items = board.data?.items ?? [];
  return (
    <div className="space-y-6">
      {header}
      <ReviewBoardFilters filters={filters} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          {!board.data ? (
            <EmptyStatePanel
              icon={<CloudOff className="h-6 w-6" aria-hidden />}
              title="The review board is temporarily unavailable"
              description="The review service didn't respond. Try again in a moment."
            />
          ) : items.length === 0 ? (
            <EmptyStatePanel
              icon={<MessageSquareText className="h-6 w-6" aria-hidden />}
              title="No review requests match"
              description="Try another filter, or open one of your games and ask for a review."
            />
          ) : (
            <ul className="space-y-3" aria-label="Review requests">
              {items.map((card) => <ReviewCard key={card.id} card={card} now={now} />)}
            </ul>
          )}
          {board.data?.nextCursor ? (
            <Link
              href={`/reviews${boardQuery(filters, { cursor: board.data.nextCursor })}`}
              rel="nofollow"
              className="inline-flex min-h-[44px] items-center rounded-full border-2 border-line px-5 font-semibold text-text hover:bg-bg-elevated"
            >
              Older requests →
            </Link>
          ) : null}
        </div>
        <aside className="min-w-0 space-y-6">
          <SignedIn>
            <HelpWithList now={now} />
          </SignedIn>
          <ReviewLeaderboard initial={leaderboard.data} />
        </aside>
      </div>
    </div>
  );
}
