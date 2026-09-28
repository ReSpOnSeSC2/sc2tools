import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { BuildGuide } from "@/components/guides/build/BuildGuide";
import { buildMetadata, guidePaths } from "@/components/guides/guideMetadata";
import { guideUnavailableMetadata } from "@/components/guides/guideSeo";
import { fetchGuideBuild, fetchPublishedGuidePaths } from "@/lib/guides/api";
import { lowercaseGuidePath } from "@/lib/guides/canonicalPath";
import { GuideUnavailableError } from "@/lib/guides/guideErrors";
import { guidesEnabled } from "@/lib/guides/flags";

/**
 * /guides/[matchup]/[build] — one community build guide.
 *
 * Status semantics (no loading.tsx above this page, and notFound /
 * permanentRedirect are raised in generateMetadata too, before any
 * streaming): flag off or API 404 → real 404; alias slug → 308 to the
 * new URL; mixed-case URL → 308 to the lowercase one; below the
 * publishing floor → "Not enough games yet" + noindex.
 *
 * Incremental static regeneration: rendered on the first request, then
 * served from the cache for 6 h (the API data's own window; the nightly
 * job also purges /guides on demand via /api/revalidate-guides). An API
 * outage THROWS GuideUnavailableError instead of rendering: a thrown
 * render is never cached, so a page whose window has passed keeps serving
 * its last good render, and a page with no usable render (never visited,
 * or just purged) answers an uncached 5xx until the API is back.
 * (Rendering the "unavailable" state would freeze it for 6 h, and opting
 * an ISR page out at runtime with noStore() is a 500 in Next 15 too.)
 */
export const revalidate = 21600;

/** Nothing is prerendered at `next build` (the API may be unreachable there). */
export function generateStaticParams(): Array<{ matchup: string; build: string }> {
  return [];
}

interface BuildPageProps {
  params: Promise<{ matchup: string; build: string }>;
}

async function loadBuild(params: BuildPageProps["params"]) {
  if (!guidesEnabled()) notFound();
  const { matchup, build } = await params;
  const canonical = guidePaths.build(matchup, build);
  const lowercase = lowercaseGuidePath(canonical);
  if (lowercase) permanentRedirect(lowercase);
  const result = await fetchGuideBuild(matchup, build);
  if (result.kind === "not_found") notFound();
  if (result.kind === "moved") permanentRedirect(result.path);
  return { result, canonical };
}

export async function generateMetadata({ params }: BuildPageProps): Promise<Metadata> {
  const { result, canonical } = await loadBuild(params);
  if (result.kind === "unavailable") return guideUnavailableMetadata(canonical, "Build order guide");
  return buildMetadata(result.data);
}

export default async function BuildGuidePage({ params }: BuildPageProps) {
  const { result, canonical } = await loadBuild(params);
  if (result.kind === "unavailable") throw new GuideUnavailableError(canonical);
  // Map cells carry no published flag of their own; gate their links on the published list.
  const publishedPaths = result.data.published ? await fetchPublishedGuidePaths() : null;
  return <BuildGuide payload={result.data} publishedPaths={publishedPaths} />;
}
