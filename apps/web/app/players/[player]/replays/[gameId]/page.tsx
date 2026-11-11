import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import type { PublicReplayDetailResponse } from "@/components/analyzer/replays/types";
import { SharedReplayAnalysisContent } from "@/components/public-profile/SharedReplayAnalysisContent";
import { PublicUnavailable } from "@/components/public-profile/PublicUnavailable";
import { parseArchiveFrom, parseArchiveQuery, sharedAnalysisHref } from "@/components/public-profile/archiveQuery";
import { archiveRequestQuery } from "@/components/public-profile/archiveRequest";
import { apiFetch } from "@/lib/api";
import { isPublicReplayReference } from "@/lib/replayRouteAccess";
import { readPublicReplayCard } from "@/lib/publicReplayCard";
import { sharedReplayTitle } from "@/lib/sharedReplayTitle";
import { siteTitle } from "@/lib/siteTitle";
import { SharedAnalysisTeaser } from "@/components/public-profile/SharedAnalysisTeaser";

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
  const handle = safeDecode(player);
  const reference = safeDecode(gameId);
  const session = await auth();
  if (!session.userId) {
    const result = await readPublicReplayCard(handle, reference);
    if (result.status === 404) notFound();
    return replayMetadata(result.data?.profile.handle ?? handle, reference,
      result.data ? sharedReplayTitle(result.data.profile.displayName, result.data.game) : undefined);
  }
  const { queryKey } = await readContext(searchParams);
  const result = await fetchAnalysis(handle, reference, queryKey);
  if (!result.ok && result.status === 404) notFound();
  const shared = result.ok ? result.data : null;
  return replayMetadata(shared?.profile.handle ?? handle, shared?.game.gameId ?? reference,
    shared ? sharedReplayTitle(shared.profile.displayName, shared.game) : undefined);
}

function replayMetadata(handle: string, reference: string, title = "Shared replay analysis"): Metadata {
  const description = "Sign in to view this shared replay's timeline, macro breakdown and build orders.";
  const canonical = isPublicReplayReference(reference) ? analysisPath(handle, reference)
    : "/players/" + encodeURIComponent(handle) + "/replays";
  return {
    title,
    description,
    robots: { index: false, follow: false },
    alternates: { canonical },
    openGraph: { title: siteTitle(title), description, url: canonical },
  };
}

function analysisPath(handle: string, reference: string) {
  return sharedAnalysisHref("/players/" + encodeURIComponent(handle) + "/replays", reference);
}

export default async function SharedReplayAnalysisPage({ params, searchParams }: PageProps) {
  const { player, gameId } = await params;
  const requestedPlayer = safeDecode(player);
  const requestedGameId = safeDecode(gameId);
  const session = await auth();
  if (!session.userId) {
    const result = await readPublicReplayCard(requestedPlayer, requestedGameId);
    if (!result.data) {
      if (result.status === 404) notFound();
      return <PublicUnavailable surface="analysis" reason={result.status === 429 ? "busy" : "outage"} />;
    }
    if (result.data.profile.handle !== requestedPlayer) redirect(analysisPath(result.data.profile.handle, requestedGameId));
    return <SharedAnalysisTeaser card={result.data} reference={requestedGameId} />;
  }
  const { from, queryKey } = await readContext(searchParams);
  const result = await fetchAnalysis(requestedPlayer, requestedGameId, queryKey);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <PublicUnavailable surface="analysis" reason={result.status === 429 ? "busy" : "outage"} />;
  }
  const reference = result.data.game.gameId;
  if (reference && (reference !== requestedGameId || result.data.profile.handle !== requestedPlayer)) {
    redirect(sharedAnalysisHref("/players/" + encodeURIComponent(result.data.profile.handle) + "/replays", reference, from));
  }
  return <SharedReplayAnalysisContent key={reference} data={result.data} from={from} />;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
