import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { BuildGuide } from "@/components/guides/build/BuildGuide";
import { GuideUnavailable } from "@/components/guides/GuideStates";
import { buildMetadata, guidePaths } from "@/components/guides/guideMetadata";
import { guideUnavailableMetadata } from "@/components/guides/guideSeo";
import { fetchGuideBuild } from "@/lib/guides/api";
import { guidesEnabled } from "@/lib/guides/flags";

/**
 * /guides/[matchup]/[build] — one community build guide.
 *
 * Status semantics (no loading.tsx above this page, and notFound /
 * permanentRedirect are raised in generateMetadata too, before any
 * streaming): flag off or API 404 → real 404; alias slug → 308 to the
 * new URL; API down → 200 "temporarily unavailable" + noindex; below
 * the publishing floor → "Not enough games yet" + noindex.
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

interface BuildPageProps {
  params: Promise<{ matchup: string; build: string }>;
}

async function loadBuild(params: BuildPageProps["params"]) {
  if (!guidesEnabled()) notFound();
  const { matchup, build } = await params;
  const result = await fetchGuideBuild(matchup, build);
  if (result.kind === "not_found") notFound();
  if (result.kind === "moved") permanentRedirect(result.path);
  return { result, canonical: guidePaths.build(matchup, build) };
}

export async function generateMetadata({ params }: BuildPageProps): Promise<Metadata> {
  const { result, canonical } = await loadBuild(params);
  if (result.kind === "unavailable") return guideUnavailableMetadata(canonical, "Build order guide");
  return buildMetadata(result.data);
}

export default async function BuildGuidePage({ params }: BuildPageProps) {
  const { result } = await loadBuild(params);
  if (result.kind === "unavailable") return <GuideUnavailable />;
  return <BuildGuide payload={result.data} />;
}
