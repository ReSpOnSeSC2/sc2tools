import { GUIDE_OG_CONTENT_TYPE, GUIDE_OG_SIZE, renderGuideOgImage } from "@/components/guides/og/GuideOgCard";
import { counterOgCard } from "@/components/guides/og/guideOgData";
import { fetchGuideCounter } from "@/lib/guides/api";
import { guidesEnabled } from "@/lib/guides/flags";

/**
 * Social card for a "How to beat …" page: the viewer race's win rate
 * against the strategy, n and the number of ranked openers. Flag off,
 * API down, unknown or unpublished → the neutral branded card.
 */
export const alt = "SC2 Tools counter guide";
export const size = GUIDE_OG_SIZE;
export const contentType = GUIDE_OG_CONTENT_TYPE;

export default async function CounterGuideOpenGraphImage({
  params,
}: {
  params: Promise<{ matchup: string; strategy: string }>;
}) {
  const { matchup, strategy } = await params;
  const result = guidesEnabled() ? await fetchGuideCounter(matchup, strategy) : null;
  return renderGuideOgImage(result?.kind === "ok" ? counterOgCard(result.data) : null);
}
