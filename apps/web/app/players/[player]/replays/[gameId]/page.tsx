import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { PublicReplayDetailResponse } from "@/components/analyzer/replays/types";
import { PublicReplayAnalysis } from "@/components/public-profile/PublicReplayAnalysis";
import { PublicReplayUnavailable } from "@/components/public-profile/PublicReplayUnavailable";
import { apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PageProps {
  params: Promise<{ player: string; gameId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { player, gameId } = await params;
  const canonical = `/players/${encodeURIComponent(player)}/replays/${encodeURIComponent(gameId)}`;
  return {
    title: "Shared replay analysis · SC2 Tools",
    description: "Sign in to view this shared replay analysis and macro breakdown.",
    robots: { index: false, follow: false },
    alternates: { canonical },
  };
}

export default async function SharedReplayAnalysisPage({ params }: PageProps) {
  const { player, gameId } = await params;
  const requestedPlayer = safeDecode(player);
  const requestedGameId = safeDecode(gameId);
  const result = await apiFetch<PublicReplayDetailResponse>(
    `/v1/public/replays/${encodeURIComponent(requestedPlayer)}/${encodeURIComponent(requestedGameId)}`,
  );
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <PublicReplayUnavailable detail />;
  }
  if (result.data.profile.handle !== requestedPlayer) {
    redirect(
      `/players/${encodeURIComponent(result.data.profile.handle)}/replays/${encodeURIComponent(requestedGameId)}`,
    );
  }
  return <PublicReplayAnalysis data={result.data} />;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
