import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { MapGuide } from "@/components/guides/map/MapGuide";
import { GuideUnavailable } from "@/components/guides/GuideStates";
import { guidePaths, mapMetadata } from "@/components/guides/guideMetadata";
import { guideUnavailableMetadata } from "@/components/guides/guideSeo";
import { fetchGuideMap } from "@/lib/guides/api";
import { guidesEnabled } from "@/lib/guides/flags";

/**
 * /guides/maps/[map] — matchup win rates and the best openers on one
 * ladder map. 404 / 308 raised in generateMetadata; API down → noindex
 * "unavailable"; unpublished → "Not enough games yet" + noindex.
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

interface MapPageProps {
  params: Promise<{ map: string }>;
}

async function loadMap(params: MapPageProps["params"]) {
  if (!guidesEnabled()) notFound();
  const { map } = await params;
  const result = await fetchGuideMap(map);
  if (result.kind === "not_found") notFound();
  if (result.kind === "moved") permanentRedirect(result.path);
  return { result, canonical: guidePaths.map(map) };
}

export async function generateMetadata({ params }: MapPageProps): Promise<Metadata> {
  const { result, canonical } = await loadMap(params);
  if (result.kind === "unavailable") return guideUnavailableMetadata(canonical, "Map guide");
  return mapMetadata(result.data);
}

export default async function MapGuidePage({ params }: MapPageProps) {
  const { result } = await loadMap(params);
  if (result.kind === "unavailable") return <GuideUnavailable />;
  return <MapGuide payload={result.data} />;
}
