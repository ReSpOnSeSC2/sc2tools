import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { MapsList } from "@/components/guides/map/MapsList";
import { GuideUnavailable } from "@/components/guides/GuideStates";
import { guidePaths, mapsListMetadata } from "@/components/guides/guideMetadata";
import { guideUnavailableMetadata } from "@/components/guides/guideSeo";
import { fetchGuideIndex } from "@/lib/guides/api";
import { guidesEnabled } from "@/lib/guides/flags";

/**
 * /guides/maps — the list of published map guides (read from the hub
 * payload; there is no separate list endpoint).
 *
 * Rendered per request, NOT prerendered: this route has no params, so a
 * static prerender would run at `next build` — where the API is often
 * unreachable (CI builds before the e2e fixture API starts) — and freeze
 * the "temporarily unavailable" page for the whole ISR window. The API
 * data is still cached: lib/guides/api.ts fetches with
 * `next.revalidate = GUIDE_REVALIDATE_SEC` and the "guides" tag, and Next
 * caches only 200 responses, so an outage is never cached.
 */
export const dynamic = "force-dynamic";

async function loadMaps() {
  if (!guidesEnabled()) notFound();
  const result = await fetchGuideIndex();
  if (result.kind === "not_found") notFound();
  if (result.kind === "moved") permanentRedirect(result.path);
  return result;
}

export async function generateMetadata(): Promise<Metadata> {
  const result = await loadMaps();
  if (result.kind === "unavailable") return guideUnavailableMetadata(guidePaths.maps(), "Map guides");
  return mapsListMetadata(result.data);
}

export default async function MapGuidesPage() {
  const result = await loadMaps();
  if (result.kind === "unavailable") return <GuideUnavailable title="Map guides are temporarily unavailable" />;
  return <MapsList payload={result.data} />;
}
