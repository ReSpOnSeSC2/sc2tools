import type { MetadataRoute } from "next";
import { getJson } from "@/lib/serverApi";
import { getInstantImportMode } from "@/lib/instant/flag";
import { reviewsRollout } from "@/lib/reviews";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://sc2tools.com";

type Route = {
  path: string;
  priority: number;
  changeFrequency: NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;
};

// Public, indexable routes only. Auth/token-gated routes (/app, /devices,
// /streaming, /overlay, /admin, /settings, /welcome) are intentionally
// excluded — crawlers just get bounced to sign-in there.
const ROUTES: Route[] = [
  { path: "/", priority: 1.0, changeFrequency: "weekly" },
  { path: "/download", priority: 0.9, changeFrequency: "weekly" },
  { path: "/community", priority: 0.8, changeFrequency: "daily" },
  { path: "/builds", priority: 0.7, changeFrequency: "daily" },
  { path: "/meta", priority: 0.7, changeFrequency: "daily" },
  { path: "/definitions", priority: 0.5, changeFrequency: "monthly" },
  { path: "/donate", priority: 0.4, changeFrequency: "monthly" },
  { path: "/legal/privacy", priority: 0.2, changeFrequency: "yearly" },
  { path: "/legal/terms", priority: 0.2, changeFrequency: "yearly" },
];

// /try (in-browser replay analysis) is public only once Instant Analysis
// is rolled out to everyone; in "admins"/"off" mode it is not listed.
const TRY_ROUTE: Route = { path: "/try", priority: 0.8, changeFrequency: "monthly" };

function staticRoutes(): Route[] {
  return getInstantImportMode() === "all" ? [...ROUTES, TRY_ROUTE] : ROUTES;
}

// Regenerated at most hourly; the API list is already capped.
export const revalidate = 3600;

/**
 * Static marketing routes plus, once the Replay Review Exchange is live,
 * the review board and every review that passed the quality gate (at
 * least one helpful or best review — the API's ``indexable`` flag). An
 * unreachable API degrades to the static list, never an error.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = new Date();
  const entries: MetadataRoute.Sitemap = staticRoutes().map((route) => ({
    url: `${SITE_URL}${route.path}`,
    lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
  if (reviewsRollout() !== "on") return entries;
  entries.push({ url: `${SITE_URL}/reviews`, lastModified, changeFrequency: "hourly", priority: 0.7 });
  const reviews = await getJson<{ items: Array<{ id: string; lastModified: string | null }> }>(
    "/v1/reviews/sitemap",
    { revalidateSec: 3600 },
  );
  for (const item of reviews?.items ?? []) {
    if (!/^[A-Za-z0-9_-]{16}$/.test(item.id)) continue;
    entries.push({
      url: `${SITE_URL}/reviews/${item.id}`,
      lastModified: item.lastModified ? new Date(item.lastModified) : lastModified,
      changeFrequency: "weekly",
      priority: 0.6,
    });
  }
  return entries;
}
