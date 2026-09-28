import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { MatchupGuide } from "@/components/guides/matchup/MatchupGuide";
import { GuideUnavailable } from "@/components/guides/GuideStates";
import { guidePaths, matchupMetadata } from "@/components/guides/guideMetadata";
import { guideUnavailableMetadata } from "@/components/guides/guideSeo";
import { fetchGuideMatchup } from "@/lib/guides/api";
import { parseGuideBand, parseGuideEra } from "@/lib/guides/format";
import { guidesEnabled } from "@/lib/guides/flags";

/**
 * /guides/[matchup] — the ranked openers of one matchup, filterable by
 * opponent band (`?band=league:4`, `?band=mmr:4500`) and patch era
 * (`?era=before`). Unknown filter values are ignored (all bands, current
 * patch). The canonical URL never carries the query.
 */
export const revalidate = 21600; // = GUIDE_REVALIDATE_SEC (literal: segment config must be static)

type SearchParams = Record<string, string | string[] | undefined>;

interface MatchupPageProps {
  params: Promise<{ matchup: string }>;
  searchParams: Promise<SearchParams>;
}

async function loadMatchup({ params, searchParams }: MatchupPageProps) {
  if (!guidesEnabled()) notFound();
  const [{ matchup }, query] = await Promise.all([params, searchParams]);
  const result = await fetchGuideMatchup(matchup, {
    band: parseGuideBand(query.band),
    era: parseGuideEra(query.era),
  });
  if (result.kind === "not_found") notFound();
  if (result.kind === "moved") permanentRedirect(result.path);
  return { result, canonical: guidePaths.matchup(matchup) };
}

export async function generateMetadata(props: MatchupPageProps): Promise<Metadata> {
  const { result, canonical } = await loadMatchup(props);
  if (result.kind === "unavailable") return guideUnavailableMetadata(canonical, "Matchup build orders");
  return matchupMetadata(result.data);
}

export default async function MatchupGuidePage(props: MatchupPageProps) {
  const { result } = await loadMatchup(props);
  if (result.kind === "unavailable") return <GuideUnavailable />;
  return <MatchupGuide payload={result.data} />;
}
