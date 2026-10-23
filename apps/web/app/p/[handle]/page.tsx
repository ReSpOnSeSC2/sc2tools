import type { Metadata } from "next";
import { cache } from "react";
import { PublicFetchError } from "@/lib/publicFetchError";
import { notFound } from "next/navigation";
import { getJsonWithStatus } from "@/lib/serverApi";
import { SITE_NAME, siteTitle } from "@/lib/siteTitle";
import { PublicProfile } from "@/components/public-profile/PublicProfile";
import type { PublicProfileResponse } from "@/components/public-profile/types";

/**
 * Opt-in profiles cache successful data for five minutes. Request-scoped
 * memoization shares the metadata/page read. Only a positive 404 means
 * private or missing; throwing on temporary failures preserves the last
 * successful ISR page and gives first-time visitors a temporary server error.
 */
export const revalidate = 300;

interface PageParams {
  params: Promise<{ handle: string }>;
}

const fetchProfile = cache((handle: string) => {
  return getJsonWithStatus<PublicProfileResponse>(
    `/v1/public/profile/${encodeURIComponent(handle)}`,
    { revalidateSec: 300 },
  );
});

export async function generateMetadata({
  params,
}: PageParams): Promise<Metadata> {
  const { handle } = await params;
  const { data, status } = await fetchProfile(handle);
  const canonical = `/p/${handle}`;
  const profile = data?.profile;
  if (!profile) {
    if (status === 404) notFound();
    throw new PublicFetchError(status);
  }
  const { displayName, totals } = profile;
  const raceLabel = profile.mainRace ? `${profile.mainRace} player` : "player";
  const description =
    totals.games > 0
      ? `${displayName} — StarCraft II ${raceLabel}. ${totals.games} games, ${totals.wins}–${totals.losses}, ${Math.round(totals.winRate * 100)}% win rate. See their signature builds on ${SITE_NAME}.`
      : `${displayName} — StarCraft II ${raceLabel} on ${SITE_NAME}.`;
  const title = `${displayName} — StarCraft II player profile`;
  // Social cards get no title template, so they carry the brand themselves.
  const shareTitle = siteTitle(title);
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      type: "profile",
      title: shareTitle,
      description,
      url: canonical,
    },
    twitter: {
      card: "summary_large_image",
      title: shareTitle,
      description,
    },
  };
}

export default async function PublicProfilePage({ params }: PageParams) {
  const { handle } = await params;
  const { data, status } = await fetchProfile(handle);
  if (!data?.profile) {
    if (status === 404) notFound();
    throw new PublicFetchError(status);
  }
  return <PublicProfile profile={data.profile} />;
}
