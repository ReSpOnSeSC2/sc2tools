import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { CounterList } from "@/components/guides/counter/CounterList";
import { counterListMetadata, guidePaths } from "@/components/guides/guideMetadata";
import { guideUnavailableMetadata } from "@/components/guides/guideSeo";
import { fetchGuideMatchup } from "@/lib/guides/api";
import { lowercaseGuidePath } from "@/lib/guides/canonicalPath";
import { GuideUnavailableError } from "@/lib/guides/guideErrors";
import { guidesEnabled } from "@/lib/guides/flags";

/**
 * /guides/[matchup]/counter — the list of "How to beat …" pages for a
 * matchup, read from the (unfiltered) matchup payload. Mixed-case URLs
 * 308 to lowercase.
 *
 * Incremental static regeneration, like the build page: cached for 6 h
 * (purged on demand after the nightly run); an API outage throws
 * GuideUnavailableError so it is never cached (the last good render keeps
 * serving; with none, an uncached 5xx until the API is back).
 */
export const revalidate = 21600;

/** Nothing is prerendered at `next build` (the API may be unreachable there). */
export function generateStaticParams(): Array<{ matchup: string }> {
  return [];
}

interface CounterListPageProps {
  params: Promise<{ matchup: string }>;
}

async function loadCounters(params: CounterListPageProps["params"]) {
  if (!guidesEnabled()) notFound();
  const { matchup } = await params;
  const canonical = guidePaths.counters(matchup);
  const lowercase = lowercaseGuidePath(canonical);
  if (lowercase) permanentRedirect(lowercase);
  const result = await fetchGuideMatchup(matchup);
  if (result.kind === "not_found") notFound();
  if (result.kind === "moved") permanentRedirect(`${result.path}/counter`);
  return { result, canonical };
}

export async function generateMetadata({ params }: CounterListPageProps): Promise<Metadata> {
  const { result, canonical } = await loadCounters(params);
  if (result.kind === "unavailable") return guideUnavailableMetadata(canonical, "Counter guides");
  return counterListMetadata(result.data);
}

export default async function CounterListPage({ params }: CounterListPageProps) {
  const { result, canonical } = await loadCounters(params);
  if (result.kind === "unavailable") throw new GuideUnavailableError(canonical);
  return <CounterList payload={result.data} />;
}
