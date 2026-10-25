import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { GuideUnavailable } from "@/components/guides/GuideStates";
import { GuideVideosList } from "@/components/guides/GuideVideosList";
import { guidePaths } from "@/components/guides/guideMetadata";
import { guideMetadata, guideUnavailableMetadata } from "@/components/guides/guideSeo";
import { fetchGuideVideos } from "@/lib/guides/api";
import { guidesEnabled } from "@/lib/guides/flags";
import { filterGuideVideos, parseVideoMatchup } from "@/lib/guides/videoFilters";

// Fetch per request so an API outage at build time cannot freeze this page.
// fetchGuideVideos still shares the guide data cache and revalidation tag.
export const dynamic = "force-dynamic";

async function loadVideos() {
  if (!guidesEnabled()) notFound();
  const result = await fetchGuideVideos();
  if (result.kind === "not_found") notFound();
  if (result.kind === "moved") permanentRedirect(result.path);
  return result;
}

export async function generateMetadata(): Promise<Metadata> {
  const result = await loadVideos();
  if (result.kind === "unavailable") return guideUnavailableMetadata(guidePaths.videos(), "Build order videos");
  return guideMetadata({
    title: "StarCraft II build order videos | SC2 Tools",
    description: "Browse all build order videos from ReSpOnSe, newest first, with a separate archive of videos from the 8-worker patch.",
    canonical: guidePaths.videos(),
    noindex: result.data.videos.length === 0 && result.data.eightWorkerVideos.length === 0,
  });
}

export default async function GuideVideosPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const result = await loadVideos();
  if (result.kind === "unavailable") return <GuideUnavailable title="Build order videos are temporarily unavailable" />;
  const query = await searchParams;
  const initialMatchup = parseVideoMatchup(query?.matchup);
  const initialVideos = filterGuideVideos(result.data.videos, initialMatchup);
  return <GuideVideosList payload={result.data} initialMatchup={initialMatchup} initialVideos={initialVideos} />;
}
