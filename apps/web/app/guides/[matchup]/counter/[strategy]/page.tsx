import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { CounterGuide } from "@/components/guides/counter/CounterGuide";
import { counterMetadata, guidePaths } from "@/components/guides/guideMetadata";
import { guideUnavailableMetadata } from "@/components/guides/guideSeo";
import { fetchGuideCounter } from "@/lib/guides/api";
import { lowercaseGuidePath } from "@/lib/guides/canonicalPath";
import { GuideUnavailableError } from "@/lib/guides/guideErrors";
import { guidesEnabled } from "@/lib/guides/flags";

/**
 * /guides/[matchup]/counter/[strategy] — how to beat one opponent
 * opener. Same status semantics as the build page: 404 / 308 raised in
 * generateMetadata (mixed-case URLs 308 to lowercase), unpublished →
 * "Not enough games yet" + noindex.
 *
 * Incremental static regeneration, like the build page: cached for 6 h
 * (purged on demand after the nightly run); an API outage throws
 * GuideUnavailableError so it is never cached (the last good render keeps
 * serving; with none, an uncached 5xx until the API is back).
 */
export const revalidate = 21600;

/** Nothing is prerendered at `next build` (the API may be unreachable there). */
export function generateStaticParams(): Array<{ matchup: string; strategy: string }> {
  return [];
}

interface CounterPageProps {
  params: Promise<{ matchup: string; strategy: string }>;
}

async function loadCounter(params: CounterPageProps["params"]) {
  if (!guidesEnabled()) notFound();
  const { matchup, strategy } = await params;
  const canonical = guidePaths.counter(matchup, strategy);
  const lowercase = lowercaseGuidePath(canonical);
  if (lowercase) permanentRedirect(lowercase);
  const result = await fetchGuideCounter(matchup, strategy);
  if (result.kind === "not_found") notFound();
  if (result.kind === "moved") permanentRedirect(result.path);
  return { result, canonical };
}

export async function generateMetadata({ params }: CounterPageProps): Promise<Metadata> {
  const { result, canonical } = await loadCounter(params);
  if (result.kind === "unavailable") return guideUnavailableMetadata(canonical, "Counter guide");
  return counterMetadata(result.data);
}

export default async function CounterGuidePage({ params }: CounterPageProps) {
  const { result, canonical } = await loadCounter(params);
  if (result.kind === "unavailable") throw new GuideUnavailableError(canonical);
  return <CounterGuide payload={result.data} />;
}
