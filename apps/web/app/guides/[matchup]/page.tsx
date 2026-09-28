import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { MatchupGuide } from "@/components/guides/matchup/MatchupGuide";
import { GuideUnavailable } from "@/components/guides/GuideStates";
import { guidePaths, matchupMetadata } from "@/components/guides/guideMetadata";
import { guideUnavailableMetadata } from "@/components/guides/guideSeo";
import { fetchGuideMatchup } from "@/lib/guides/api";
import { guideBandQueryString, parseGuideBand, parseGuideEra } from "@/lib/guides/format";
import { lowercaseGuidePath } from "@/lib/guides/canonicalPath";
import { guidesEnabled } from "@/lib/guides/flags";

/**
 * /guides/[matchup] — the ranked openers of one matchup, filterable by
 * opponent band (`?band=league:4`, `?band=mmr:4500`) and patch era
 * (`?era=before`). Unknown filter values are ignored (all bands, current
 * patch). The canonical URL never carries the query. A mixed-case URL
 * ("/guides/PvZ", e.g. from an old /meta?matchup=PvZ link) 308s to the
 * lowercase one, keeping a valid band / era filter.
 *
 * Rendered per request: the page reads its band / era query, which makes
 * every render request-specific anyway (the build, counter and map pages
 * are ISR). The API reads stay cached: lib/guides/api.ts fetches with
 * `next.revalidate = GUIDE_REVALIDATE_SEC` + the "guides" tag (Next
 * caches only 200s) and shares one call between generateMetadata and the
 * page (React cache).
 */
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

interface MatchupPageProps {
  params: Promise<{ matchup: string }>;
  searchParams: Promise<SearchParams>;
}

async function loadMatchup({ params, searchParams }: MatchupPageProps) {
  if (!guidesEnabled()) notFound();
  const [{ matchup }, query] = await Promise.all([params, searchParams]);
  const filters = { band: parseGuideBand(query.band), era: parseGuideEra(query.era) };
  const lowercase = lowercaseGuidePath(guidePaths.matchup(matchup));
  if (lowercase) permanentRedirect(`${lowercase}${guideBandQueryString(filters.band, filters.era)}`);
  const result = await fetchGuideMatchup(matchup, filters);
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
