import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getJson } from "@/lib/serverApi";
import { PublicProfile } from "@/components/public-profile/PublicProfile";
import type { PublicProfileResponse } from "@/components/public-profile/types";

/**
 * Public, opt-in player page — /p/[handle].
 *
 * Resolution: GET /v1/public/profile/:handle returns 200 { profile }
 * only when the user has opted in (published a build under a public
 * name). Every private / unknown / malformed handle returns 404, which
 * we surface as Next's notFound() — a signed-out visitor gets a clean
 * 404, never a broken shell, and a deliberately-private user is
 * indistinguishable from a missing one.
 *
 * SSR at request time (short ISR window) so shared links crawl cleanly
 * and freshly-opted-in players appear quickly.
 */
export const revalidate = 300;

interface PageParams {
  params: Promise<{ handle: string }>;
}

const SITE_NAME = "SC2 Tools";

export async function generateMetadata({
  params,
}: PageParams): Promise<Metadata> {
  const { handle } = await params;
  const data = await getJson<PublicProfileResponse>(
    `/v1/public/profile/${encodeURIComponent(handle)}`,
  );
  const canonical = `/p/${handle}`;
  const profile = data?.profile;
  if (!profile) {
    // Neutral, non-indexable metadata for private / missing profiles —
    // the wording never reveals whether the handle exists.
    return {
      title: `Player profile — ${SITE_NAME}`,
      description: "This SC2 Tools player profile is private or doesn't exist.",
      robots: { index: false, follow: false },
      alternates: { canonical },
    };
  }
  const { displayName, totals } = profile;
  const raceLabel = profile.mainRace ? `${profile.mainRace} player` : "player";
  const description =
    totals.games > 0
      ? `${displayName} — StarCraft II ${raceLabel}. ${totals.games} games, ${totals.wins}–${totals.losses}, ${Math.round(totals.winRate * 100)}% win rate. See their signature builds on ${SITE_NAME}.`
      : `${displayName} — StarCraft II ${raceLabel} on ${SITE_NAME}.`;
  const title = `${displayName} — StarCraft II player profile — ${SITE_NAME}`;
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      type: "profile",
      title,
      description,
      url: canonical,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export default async function PublicProfilePage({ params }: PageParams) {
  const { handle } = await params;
  const data = await getJson<PublicProfileResponse>(
    `/v1/public/profile/${encodeURIComponent(handle)}`,
  );
  if (!data?.profile) notFound();
  return <PublicProfile profile={data.profile} />;
}
