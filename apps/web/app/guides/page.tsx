import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { GuideHub } from "@/components/guides/hub/GuideHub";
import { GuideUnavailable } from "@/components/guides/GuideStates";
import { guidePaths, hubMetadata } from "@/components/guides/guideMetadata";
import { guideUnavailableMetadata } from "@/components/guides/guideSeo";
import { fetchGuideIndex } from "@/lib/guides/api";
import { guidesEnabled } from "@/lib/guides/flags";

/**
 * /guides — the build-guide hub: what's winning in each of the nine
 * matchups this week, the latest channel videos and the map guides.
 * Flag off or API 404 → 404; API down → noindex "unavailable" (200).
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

async function loadIndex() {
  if (!guidesEnabled()) notFound();
  const result = await fetchGuideIndex();
  if (result.kind === "not_found") notFound();
  if (result.kind === "moved") permanentRedirect(result.path);
  return result;
}

export async function generateMetadata(): Promise<Metadata> {
  const result = await loadIndex();
  if (result.kind === "unavailable") return guideUnavailableMetadata(guidePaths.hub(), "Build order guides");
  return hubMetadata(result.data);
}

export default async function GuidesHubPage() {
  const result = await loadIndex();
  if (result.kind === "unavailable") return <GuideUnavailable title="Build guides are temporarily unavailable" />;
  return <GuideHub payload={result.data} />;
}
