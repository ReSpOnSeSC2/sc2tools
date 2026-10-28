import type { Metadata } from "next";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import type { PublicReplayDetailResponse } from "@/components/analyzer/replays/types";
import { SharedReplayAnalysisContent } from "@/components/public-profile/SharedReplayAnalysisContent";
import { PublicUnavailable } from "@/components/public-profile/PublicUnavailable";
import { parseArchiveFrom, parseArchiveQuery, sharedAnalysisHref } from "@/components/public-profile/archiveQuery";
import { archiveRequestQuery } from "@/components/public-profile/archiveRequest";
import { apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PageProps {
  params: Promise<{ player: string; gameId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

const fetchAnalysis = cache((player: string, gameId: string, queryKey: string) => apiFetch<PublicReplayDetailResponse>(
  `/v1/public/replays/${encodeURIComponent(player)}/${encodeURIComponent(gameId)}${queryKey ? `?${queryKey}` : ""}`,
));

async function readContext(searchParams: PageProps["searchParams"]) {
  const raw = (await searchParams)?.from;
  const from = parseArchiveFrom(Array.isArray(raw) ? raw[0] : raw);
  return { from, queryKey: archiveRequestQuery(parseArchiveQuery(Object.fromEntries(new URLSearchParams(from))), false) };
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { player, gameId } = await params;
  const { queryKey } = await readContext(searchParams);
  const result = await fetchAnalysis(safeDecode(player), safeDecode(gameId), queryKey);
  if (!result.ok && result.status === 404) notFound();
  const canonical = `/players/${encodeURIComponent(player)}/replays/${encodeURIComponent(gameId)}`;
  return {
    title: "Shared replay analysis",
    description: "Sign in to view this shared replay analysis and macro breakdown.",
    robots: { index: false, follow: false },
    alternates: { canonical },
  };
}

export default async function SharedReplayAnalysisPage({ params, searchParams }: PageProps) {
  const { player, gameId } = await params;
  const requestedPlayer = safeDecode(player);
  const requestedGameId = safeDecode(gameId);
  const { from, queryKey } = await readContext(searchParams);
  const result = await fetchAnalysis(requestedPlayer, requestedGameId, queryKey);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <PublicUnavailable surface="analysis" reason={result.status === 429 ? "busy" : "outage"} />;
  }
  if (result.data.profile.handle !== requestedPlayer) {
    redirect(
      sharedAnalysisHref(`/players/${encodeURIComponent(result.data.profile.handle)}/replays`, requestedGameId, from),
    );
  }
  return <SharedReplayAnalysisContent key={result.data.game.gameId} data={result.data} from={from} />;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
