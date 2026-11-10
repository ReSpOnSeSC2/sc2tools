import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import { PublicUnavailable } from "@/components/public-profile/PublicUnavailable";
import { SharedGameView } from "@/components/share/SharedGameView";
import { SHARE_TOKEN_RE } from "@/lib/gameShares";
import { replayTimeFromQuery } from "@/lib/replayLink";
import { sharedGameTitle, sharedResultWord, type SharedGameAnalysis } from "@/lib/sharedGame";
import { getJsonWithStatus } from "@/lib/serverApi";
import { siteTitle } from "@/lib/siteTitle";

/**
 * /g/[token] — one game shared by link, no account needed.
 *
 * Outside the auth middleware: the token is the grant. The API serves only
 * the redacted game (no names, no ids, rounded ratings, day-only date) and
 * answers 404 once the owner turns the link off, deletes the game or the
 * account. Never indexed, never cached (a revoked link must stop at once),
 * and the token stays out of referrers to other sites.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = {
  params: Promise<{ token: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const fetchShare = cache(async (token: string) => {
  if (!SHARE_TOKEN_RE.test(token)) return { data: null, status: 404 };
  return getJsonWithStatus<SharedGameAnalysis>(`/v1/shares/${encodeURIComponent(token)}`);
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { token } = await params;
  const { data, status } = await fetchShare(token);
  if (!data) {
    if (status === 404) notFound();
    return { title: "Shared game", robots: { index: false, follow: false }, referrer: "same-origin" };
  }
  const game = data.game;
  const result = sharedResultWord(game.result);
  const title = `${result ? `${result}: ` : ""}${sharedGameTitle(game)}`;
  const description = [
    game.myBuild && game.oppStrategy ? `${game.myBuild} vs ${game.oppStrategy}` : game.myBuild || null,
    typeof game.macroScore === "number" ? `macro score ${Math.round(game.macroScore)}` : null,
    "Shared StarCraft II replay analysis with the map replay. No account needed.",
  ].filter(Boolean).join(" · ").slice(0, 300);
  const shareTitle = siteTitle(title);
  return {
    title,
    description,
    robots: { index: false, follow: false, nocache: true },
    referrer: "same-origin",
    openGraph: { type: "article", title: shareTitle, description },
    twitter: { card: "summary_large_image", title: shareTitle, description },
  };
}

export default async function SharedGamePage({ params, searchParams }: Params) {
  const { token } = await params;
  const { data, status } = await fetchShare(token);
  if (!data) {
    if (status === 404) notFound();
    return <PublicUnavailable surface="analysis" reason={status === 429 ? "busy" : "outage"} />;
  }
  const query = (await searchParams) ?? {};
  return <SharedGameView token={token} data={data} initialTimeSec={replayTimeFromQuery(query)} />;
}
