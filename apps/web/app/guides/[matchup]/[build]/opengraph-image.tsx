import { GUIDE_OG_CONTENT_TYPE, GUIDE_OG_SIZE, renderGuideOgImage } from "@/components/guides/og/GuideOgCard";
import { buildOgCard } from "@/components/guides/og/guideOgData";
import { fetchGuideBuild } from "@/lib/guides/api";
import { guidesEnabled } from "@/lib/guides/flags";

/**
 * Social card for a build guide: the headline win rate on a bar with its
 * 95% interval, n and the player count, from the same cached payload as
 * the page. Flag off, API down, unknown or unpublished (below the floor)
 * → the neutral branded card; an alias slug is not followed here (the
 * page itself redirects).
 */
export const alt = "SC2 Tools build order guide";
export const size = GUIDE_OG_SIZE;
export const contentType = GUIDE_OG_CONTENT_TYPE;

export default async function BuildGuideOpenGraphImage({
  params,
}: {
  params: Promise<{ matchup: string; build: string }>;
}) {
  const { matchup, build } = await params;
  const result = guidesEnabled() ? await fetchGuideBuild(matchup, build) : null;
  return renderGuideOgImage(result?.kind === "ok" ? buildOgCard(result.data) : null);
}
