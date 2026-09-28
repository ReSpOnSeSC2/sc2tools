import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { CounterGuide } from "@/components/guides/counter/CounterGuide";
import { GuideUnavailable } from "@/components/guides/GuideStates";
import { counterMetadata, guidePaths } from "@/components/guides/guideMetadata";
import { guideUnavailableMetadata } from "@/components/guides/guideSeo";
import { fetchGuideCounter } from "@/lib/guides/api";
import { guidesEnabled } from "@/lib/guides/flags";

/**
 * /guides/[matchup]/counter/[strategy] — how to beat one opponent
 * opener. Same status semantics as the build page: 404 / 308 raised in
 * generateMetadata, API down → noindex "unavailable", unpublished →
 * "Not enough games yet" + noindex.
 *
 * Rendered per request, like /guides: as an ISR page, an API blip would
 * freeze the "temporarily unavailable" state for the whole 6 h window,
 * and switching an ISR page to dynamic at runtime (noStore) is a 500 in
 * Next 15. The API reads stay cached: lib/guides/api.ts fetches with
 * `next.revalidate = GUIDE_REVALIDATE_SEC` + the "guides" tag (Next
 * caches only 200s) and shares one call between generateMetadata and the
 * page (React cache).
 */
export const dynamic = "force-dynamic";

interface CounterPageProps {
  params: Promise<{ matchup: string; strategy: string }>;
}

async function loadCounter(params: CounterPageProps["params"]) {
  if (!guidesEnabled()) notFound();
  const { matchup, strategy } = await params;
  const result = await fetchGuideCounter(matchup, strategy);
  if (result.kind === "not_found") notFound();
  if (result.kind === "moved") permanentRedirect(result.path);
  return { result, canonical: guidePaths.counter(matchup, strategy) };
}

export async function generateMetadata({ params }: CounterPageProps): Promise<Metadata> {
  const { result, canonical } = await loadCounter(params);
  if (result.kind === "unavailable") return guideUnavailableMetadata(canonical, "Counter guide");
  return counterMetadata(result.data);
}

export default async function CounterGuidePage({ params }: CounterPageProps) {
  const { result } = await loadCounter(params);
  if (result.kind === "unavailable") return <GuideUnavailable />;
  return <CounterGuide payload={result.data} />;
}
