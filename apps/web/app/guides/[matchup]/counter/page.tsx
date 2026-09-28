import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { CounterList } from "@/components/guides/counter/CounterList";
import { GuideUnavailable } from "@/components/guides/GuideStates";
import { counterListMetadata, guidePaths } from "@/components/guides/guideMetadata";
import { guideUnavailableMetadata } from "@/components/guides/guideSeo";
import { fetchGuideMatchup } from "@/lib/guides/api";
import { guidesEnabled } from "@/lib/guides/flags";

/**
 * /guides/[matchup]/counter — the list of "How to beat …" pages for a
 * matchup, read from the (unfiltered) matchup payload.
 */
export const revalidate = 21600; // = GUIDE_REVALIDATE_SEC (literal: segment config must be static)

interface CounterListPageProps {
  params: Promise<{ matchup: string }>;
}

async function loadCounters(params: CounterListPageProps["params"]) {
  if (!guidesEnabled()) notFound();
  const { matchup } = await params;
  const result = await fetchGuideMatchup(matchup);
  if (result.kind === "not_found") notFound();
  if (result.kind === "moved") permanentRedirect(`${result.path}/counter`);
  return { result, canonical: guidePaths.counters(matchup) };
}

export async function generateMetadata({ params }: CounterListPageProps): Promise<Metadata> {
  const { result, canonical } = await loadCounters(params);
  if (result.kind === "unavailable") return guideUnavailableMetadata(canonical, "Counter guides");
  return counterListMetadata(result.data);
}

export default async function CounterListPage({ params }: CounterListPageProps) {
  const { result } = await loadCounters(params);
  if (result.kind === "unavailable") return <GuideUnavailable />;
  return <CounterList payload={result.data} />;
}
