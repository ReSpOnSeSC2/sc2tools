import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { MapGuide } from "@/components/guides/map/MapGuide";
import { guidePaths, mapMetadata } from "@/components/guides/guideMetadata";
import { guideUnavailableMetadata } from "@/components/guides/guideSeo";
import { fetchGuideMap, fetchPublishedGuidePaths } from "@/lib/guides/api";
import { lowercaseGuidePath } from "@/lib/guides/canonicalPath";
import { GuideUnavailableError } from "@/lib/guides/guideErrors";
import { guidesEnabled } from "@/lib/guides/flags";

/**
 * /guides/maps/[map] — matchup win rates and the best openers on one
 * ladder map. 404 / 308 raised in generateMetadata (mixed-case URLs 308
 * to lowercase); unpublished → "Not enough games yet" + noindex.
 *
 * Incremental static regeneration, like the build page: cached for 6 h
 * (purged on demand after the nightly run); an API outage throws
 * GuideUnavailableError so it is never cached (the last good render keeps
 * serving; with none, an uncached 5xx until the API is back).
 */
export const revalidate = 21600;

/** Nothing is prerendered at `next build` (the API may be unreachable there). */
export function generateStaticParams(): Array<{ map: string }> {
  return [];
}

interface MapPageProps {
  params: Promise<{ map: string }>;
}

async function loadMap(params: MapPageProps["params"]) {
  if (!guidesEnabled()) notFound();
  const { map } = await params;
  const canonical = guidePaths.map(map);
  const lowercase = lowercaseGuidePath(canonical);
  if (lowercase) permanentRedirect(lowercase);
  const result = await fetchGuideMap(map);
  if (result.kind === "not_found") notFound();
  if (result.kind === "moved") permanentRedirect(result.path);
  return { result, canonical };
}

export async function generateMetadata({ params }: MapPageProps): Promise<Metadata> {
  const { result, canonical } = await loadMap(params);
  if (result.kind === "unavailable") return guideUnavailableMetadata(canonical, "Map guide");
  return mapMetadata(result.data);
}

export default async function MapGuidePage({ params }: MapPageProps) {
  const { result, canonical } = await loadMap(params);
  if (result.kind === "unavailable") throw new GuideUnavailableError(canonical);
  // Map openers carry no published flag of their own; gate their build links on the published list.
  const publishedPaths = result.data.published ? await fetchPublishedGuidePaths() : null;
  return <MapGuide payload={result.data} publishedPaths={publishedPaths} />;
}
