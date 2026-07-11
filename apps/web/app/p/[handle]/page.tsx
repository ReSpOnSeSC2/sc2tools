import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getJsonWithStatus } from "@/lib/serverApi";
import { PublicProfile } from "@/components/public-profile/PublicProfile";
import { ProfileUnavailable } from "@/components/public-profile/ProfileUnavailable";
import type { PublicProfileResponse } from "@/components/public-profile/types";

/**
 * Public, opt-in player page — /p/[handle].
 *
 * Resolution: GET /v1/public/profile/:handle returns 200 { profile }
 * only when the user has opted in (published a build under a public
 * name). Every private / unknown / malformed handle returns 404 from
 * the API, which we surface as Next's notFound() — a deliberately-
 * private user is indistinguishable from a missing one.
 *
 * Status-code correctness: notFound() is raised in generateMetadata
 * (which runs BEFORE streaming starts) so missing profiles return a
 * genuine 404 status — raising it only in the page body would stream a
 * 200 first because loading.tsx opens a Suspense boundary (soft-404).
 * An UNREACHABLE API (status null — deploy blip) is deliberately NOT a
 * 404: real profiles must not vanish from crawlers during an outage,
 * so that path renders a neutral noindex "unavailable" state instead.
 *
 * SSR at request time (short ISR window) so shared links crawl cleanly
 * and freshly-opted-in players appear quickly.
 */
export const revalidate = 300;

interface PageParams {
  params: Promise<{ handle: string }>;
}

const SITE_NAME = "SC2 Tools";

function fetchProfile(handle: string) {
  return getJsonWithStatus<PublicProfileResponse>(
    `/v1/public/profile/${encodeURIComponent(handle)}`,
  );
}

export async function generateMetadata({
  params,
}: PageParams): Promise<Metadata> {
  const { handle } = await params;
  const { data, status } = await fetchProfile(handle);
  const canonical = `/p/${handle}`;
  const profile = data?.profile;
  if (!profile) {
    // The API positively said "no such public profile" → real 404,
    // raised here (pre-stream) so the response status is actually 404.
    if (status !== null) notFound();
    // API unreachable: neutral, non-indexable metadata; page renders a
    // transient "unavailable" state rather than 404ing real profiles.
    return {
      title: `Player profile — ${SITE_NAME}`,
      description: "This SC2 Tools player profile is unavailable right now.",
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
  const { data, status } = await fetchProfile(handle);
  if (!data?.profile) {
    if (status !== null) notFound();
    return <ProfileUnavailable />;
  }
  return <PublicProfile profile={data.profile} />;
}
