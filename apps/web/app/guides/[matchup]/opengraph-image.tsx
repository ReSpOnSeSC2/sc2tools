import { GUIDE_OG_CONTENT_TYPE, GUIDE_OG_SIZE, renderGuideOgImage } from "@/components/guides/og/GuideOgCard";
import { matchupOgCard } from "@/components/guides/og/guideOgData";
import { fetchGuideMatchup } from "@/lib/guides/api";
import { guidesEnabled } from "@/lib/guides/flags";

/**
 * Social card for a matchup page (always the unfiltered, current-patch
 * ranking — the canonical page): the top published opener's win rate,
 * the matchup's games and players. Flag off, API down, unknown or
 * unpublished → the neutral branded card.
 */
export const alt = "SC2 Tools matchup build order guide";
export const size = GUIDE_OG_SIZE;
export const contentType = GUIDE_OG_CONTENT_TYPE;

export default async function MatchupGuideOpenGraphImage({
  params,
}: {
  params: Promise<{ matchup: string }>;
}) {
  const { matchup } = await params;
  const result = guidesEnabled() ? await fetchGuideMatchup(matchup) : null;
  return renderGuideOgImage(result?.kind === "ok" ? matchupOgCard(result.data) : null);
}
