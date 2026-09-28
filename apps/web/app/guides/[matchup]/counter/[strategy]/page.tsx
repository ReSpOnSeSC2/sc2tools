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
 */
export const revalidate = 21600; // = GUIDE_REVALIDATE_SEC (literal: segment config must be static)

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
