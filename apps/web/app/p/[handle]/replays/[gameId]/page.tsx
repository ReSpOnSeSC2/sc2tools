import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { PublicReplayDetailResponse } from "@/components/analyzer/replays/types";
import { PublicReplayAnalysis } from "@/components/public-profile/PublicReplayAnalysis";
import { PublicReplayUnavailable } from "@/components/public-profile/PublicReplayUnavailable";
import { getJsonWithStatus } from "@/lib/serverApi";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PageProps {
  params: Promise<{ handle: string; gameId: string }>;
}

function fetchReplay(handle: string, gameId: string) {
  return getJsonWithStatus<PublicReplayDetailResponse>(
    `/v1/public/replays/${encodeURIComponent(handle)}/${encodeURIComponent(gameId)}`,
  );
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { handle, gameId } = await params;
  const { data, status } = await fetchReplay(handle, gameId);
  const canonical = `/p/${encodeURIComponent(handle)}/replays/${encodeURIComponent(gameId)}`;
  if (!data?.game || !data.profile) {
    if (status === 404) notFound();
    return {
      title: "Shared replay analysis · SC2 Tools",
      description: "This replay analysis is temporarily unavailable.",
      robots: { index: false, follow: false },
      alternates: { canonical },
    };
  }
  const opponent = data.game.opponent?.displayName?.trim() || "an opponent";
  const title = `${data.profile.displayName} vs ${opponent} — replay analysis · SC2 Tools`;
  const description = `View the shared replay analysis and macro breakdown for ${data.profile.displayName}'s game${data.game.map ? ` on ${data.game.map}` : ""}.`;
  return {
    title,
    description,
    robots: { index: false, follow: false },
    alternates: { canonical },
    openGraph: { type: "article", title, description, url: canonical },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function PublicReplayAnalysisPage({ params }: PageProps) {
  const { handle, gameId } = await params;
  const { data, status } = await fetchReplay(handle, gameId);
  if (!data?.game || !data.profile) {
    if (status === 404) notFound();
    return <PublicReplayUnavailable detail />;
  }
  return <PublicReplayAnalysis data={data} />;
}
