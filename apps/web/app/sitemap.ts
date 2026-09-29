import type { MetadataRoute } from "next";
import { getJson } from "@/lib/serverApi";
import { getInstantImportMode } from "@/lib/instant/flag";
import { reviewsRollout } from "@/lib/reviews";
import { fetchGuideSitemap } from "@/lib/guides/api";
import { guidesEnabled } from "@/lib/guides/flags";
import type { CommunitySitemapPayload } from "@/lib/guides/types";
import {
  communitySitemapRows,
  finalizeSitemap,
  guideSitemapRows,
  sitemapDate,
  type SitemapRows,
} from "@/lib/sitemapEntries";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://sc2tools.com").replace(/\/+$/, "");

type Route = {
  path: string;
  priority: number;
  changeFrequency: NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;
  /**
   * When the page's own content last changed meaningfully (YYYY-MM-DD).
   * Update it in the same commit as the edit. Listing pages whose content
   * comes from the API (/community) have none. Search engines only use
   * lastmod that tracks real changes, so this is never the request time.
   */
  lastModified?: string;
};

// Public, indexable routes only. Auth/token-gated routes (/app, /devices,
// /streaming, /overlay, /admin, /settings, /welcome) are intentionally
// excluded — crawlers just get bounced to sign-in there. (/meta and
// /optimizer are gone: they redirect to /guides.)
const ROUTES: Route[] = [
  { path: "/", priority: 1.0, changeFrequency: "weekly", lastModified: "2026-09-29" },
  { path: "/download", priority: 0.9, changeFrequency: "weekly", lastModified: "2026-09-29" },
  { path: "/stream-studio", priority: 0.9, changeFrequency: "monthly", lastModified: "2026-09-29" },
  { path: "/community", priority: 0.8, changeFrequency: "daily" },
  { path: "/builds", priority: 0.7, changeFrequency: "daily", lastModified: "2026-06-01" },
  { path: "/definitions", priority: 0.5, changeFrequency: "monthly", lastModified: "2026-09-04" },
  { path: "/donate", priority: 0.4, changeFrequency: "monthly", lastModified: "2026-08-11" },
  { path: "/legal/privacy", priority: 0.2, changeFrequency: "yearly", lastModified: "2026-09-28" },
  { path: "/legal/terms", priority: 0.2, changeFrequency: "yearly", lastModified: "2026-08-11" },
];

// /try (in-browser replay analysis) is public only once Instant Analysis
// is rolled out to everyone; in "admins"/"off" mode it is not listed.
const TRY_ROUTE: Route = { path: "/try", priority: 0.8, changeFrequency: "monthly", lastModified: "2026-09-29" };

function staticRoutes(): Route[] {
  return getInstantImportMode() === "all" ? [...ROUTES, TRY_ROUTE] : ROUTES;
}

const REVIEW_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const LIST_REVALIDATE_SEC = 3600;

// Regenerated at most hourly (the reviews list moves fastest); the guide
// list is also purged on demand by /api/revalidate-guides after the
// nightly recompute. The API lists are already capped.
export const revalidate = 3600;

function staticRows(): SitemapRows {
  return staticRoutes().map((route) => {
    const lastModified = sitemapDate(route.lastModified);
    return {
      url: `${SITE_URL}${route.path}`,
      ...(lastModified ? { lastModified } : {}),
      changeFrequency: route.changeFrequency,
      priority: route.priority,
    };
  });
}

/** The newest of the given dates, if any. */
function newest(dates: ReadonlyArray<Date | undefined>): Date | undefined {
  return dates.reduce<Date | undefined>((latest, date) => (date && (!latest || date > latest) ? date : latest), undefined);
}

/**
 * Once the Replay Review Exchange is live: the review board and every
 * review that passed the quality gate (the API's ``indexable`` flag).
 */
async function reviewRows(): Promise<SitemapRows> {
  if (reviewsRollout() !== "on") return [];
  const reviews = await getJson<{ items: Array<{ id: string; lastModified: string | null }> }>(
    "/v1/reviews/sitemap",
    { revalidateSec: LIST_REVALIDATE_SEC },
  );
  const items: SitemapRows = [];
  for (const item of reviews?.items ?? []) {
    if (!REVIEW_ID_RE.test(item.id)) continue;
    const lastModified = sitemapDate(item.lastModified);
    items.push({
      url: `${SITE_URL}/reviews/${item.id}`,
      ...(lastModified ? { lastModified } : {}),
      changeFrequency: "weekly",
      priority: 0.6,
    });
  }
  // The board changes when a review does: its lastmod is the newest one.
  const boardModified = newest(items.map((row) => (row.lastModified ? new Date(row.lastModified) : undefined)));
  return [
    {
      url: `${SITE_URL}/reviews`,
      ...(boardModified ? { lastModified: boardModified } : {}),
      changeFrequency: "hourly",
      priority: 0.7,
    },
    ...items,
  ];
}

/**
 * Published guide pages (flag on). Even "/guides" itself comes from the
 * API list, never a static route: the API lists the hub only while it is
 * indexable (a published build or a channel video), so the sitemap never
 * submits the hub's noindex "nothing published yet" state, and an API
 * outage lists no guide URL at all.
 */
async function guideRows(): Promise<SitemapRows> {
  if (!guidesEnabled()) return [];
  const result = await fetchGuideSitemap();
  return guideSitemapRows(SITE_URL, result.kind === "ok" ? result.data : null);
}

/** Published community builds and their authors' public /p/ profiles. */
async function communityRows(): Promise<SitemapRows> {
  const payload = await getJson<CommunitySitemapPayload>("/v1/community/sitemap", {
    revalidateSec: LIST_REVALIDATE_SEC,
  });
  return communitySitemapRows(SITE_URL, payload);
}

/**
 * Static marketing routes, then reviews, guides, community builds and
 * profiles (in that priority order, so the cap trims profiles first).
 * An unreachable API degrades to the static list, never an error.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [reviews, guides, community] = await Promise.all([reviewRows(), guideRows(), communityRows()]);
  return finalizeSitemap([...staticRows(), ...reviews, ...guides, ...community]);
}
