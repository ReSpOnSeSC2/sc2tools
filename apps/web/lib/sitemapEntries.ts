/**
 * Pure builders for app/sitemap.ts: turn the API's sitemap payloads into
 * absolute `MetadataRoute.Sitemap` rows, drop anything that isn't a
 * well-formed public path, then dedupe and cap the whole list.
 *
 * Nothing here fetches; a missing payload (API down) is simply an empty
 * contribution, so the sitemap degrades to its static routes.
 *
 * `lastModified` is only ever a real content date from the API. A row
 * whose date is missing or unreadable carries none: search engines stop
 * trusting a sitemap whose lastmod is always "now".
 */
import type { MetadataRoute } from "next";
import type {
  CommunitySitemapBuild,
  CommunitySitemapPayload,
  CommunitySitemapProfile,
  GuideSitemapPayload,
} from "@/lib/guides/types";

export type SitemapRows = MetadataRoute.Sitemap;
type ChangeFrequency = NonNullable<SitemapRows[number]["changeFrequency"]>;

/**
 * Hard cap on URLs per sitemap file. The protocol limit is 50,000; the
 * margin keeps one file valid as the lists grow (the API caps its own
 * lists at 10,000 each).
 */
export const SITEMAP_MAX_URLS = 45_000;

/** "/guides", "/guides/pvz", "/guides/pvz/<build>", "/guides/pvz/counter/<s>", "/guides/maps/<map>". */
const GUIDE_PATH_RE = /^\/guides(\/[a-z0-9-]{1,80}){0,3}$/;
/** Community build slugs (random `build-<hex>` or legacy [A-Za-z0-9._-]). */
const COMMUNITY_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Public profile handles (apps/api/src/services/publicProfile.js HANDLE_RE). */
const PROFILE_HANDLE_RE = /^[A-Za-z0-9_-]{1,64}$/;

const GUIDE_PRIORITY = { hub: 0.8, matchup: 0.7, page: 0.6, maps: 0.5 } as const;
const COMMUNITY_BUILD_PRIORITY = 0.5;
const PROFILE_PRIORITY = 0.4;
const GUIDE_CHANGE_FREQUENCY: ChangeFrequency = "daily";
const COMMUNITY_CHANGE_FREQUENCY: ChangeFrequency = "weekly";

/** A valid date from an API ISO string, else undefined (never a stand-in "now"). */
export function sitemapDate(iso: string | null | undefined): Date | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** `{ lastModified }` when there is a real date, else nothing. */
function lastModifiedField(iso: string | null | undefined): { lastModified?: Date } {
  const date = sitemapDate(iso);
  return date ? { lastModified: date } : {};
}

function guidePriority(path: string): number {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 1) return GUIDE_PRIORITY.hub;
  if (segments[1] === "maps") return GUIDE_PRIORITY.maps;
  return segments.length === 2 ? GUIDE_PRIORITY.matchup : GUIDE_PRIORITY.page;
}

/**
 * Published guide pages from `GET /v1/guides/sitemap`.
 *
 * Example: `{ entries: [{ path: "/guides/pvz", lastModified }] }` →
 * `[{ url: "https://sc2tools.com/guides/pvz", lastModified, priority: 0.7, … }]`.
 */
export function guideSitemapRows(
  siteUrl: string,
  payload: GuideSitemapPayload | null,
): SitemapRows {
  const rows: SitemapRows = [];
  for (const entry of payload?.entries ?? []) {
    if (typeof entry?.path !== "string" || !GUIDE_PATH_RE.test(entry.path)) continue;
    rows.push({
      url: `${siteUrl}${entry.path}`,
      ...lastModifiedField(entry.lastModified),
      changeFrequency: GUIDE_CHANGE_FREQUENCY,
      priority: guidePriority(entry.path),
    });
  }
  return rows;
}

function communityBuildRows(
  siteUrl: string,
  builds: ReadonlyArray<CommunitySitemapBuild>,
): SitemapRows {
  const rows: SitemapRows = [];
  for (const build of builds) {
    if (typeof build?.slug !== "string" || !COMMUNITY_SLUG_RE.test(build.slug)) continue;
    rows.push({
      url: `${siteUrl}/community/builds/${encodeURIComponent(build.slug)}`,
      ...lastModifiedField(build.lastModified),
      changeFrequency: COMMUNITY_CHANGE_FREQUENCY,
      priority: COMMUNITY_BUILD_PRIORITY,
    });
  }
  return rows;
}

function profileRows(
  siteUrl: string,
  profiles: ReadonlyArray<CommunitySitemapProfile>,
): SitemapRows {
  const rows: SitemapRows = [];
  for (const profile of profiles) {
    if (typeof profile?.handle !== "string" || !PROFILE_HANDLE_RE.test(profile.handle)) continue;
    rows.push({
      url: `${siteUrl}/p/${encodeURIComponent(profile.handle)}`,
      ...lastModifiedField(profile.lastModified),
      changeFrequency: COMMUNITY_CHANGE_FREQUENCY,
      priority: PROFILE_PRIORITY,
    });
  }
  return rows;
}

/**
 * Published community builds and their authors' public profiles from
 * `GET /v1/community/sitemap` (build rows first, so a cap trims profiles).
 *
 * Example: `{ builds: [{ slug: "build-1a2b", … }], profiles: [{ handle: "fox", … }] }`
 * → "/community/builds/build-1a2b" and "/p/fox" rows.
 */
export function communitySitemapRows(
  siteUrl: string,
  payload: CommunitySitemapPayload | null,
): SitemapRows {
  return [
    ...communityBuildRows(siteUrl, payload?.builds ?? []),
    ...profileRows(siteUrl, payload?.profiles ?? []),
  ];
}

/**
 * Dedupe by URL (first occurrence wins, so static routes keep their
 * priority) and cap at `max`, dropping from the end — the least
 * important rows are appended last. Warns (counts only) when capped.
 *
 * Example: `finalizeSitemap([a, a, b], 1)` → `[a]` plus one warning.
 */
export function finalizeSitemap(
  rows: SitemapRows,
  max: number = SITEMAP_MAX_URLS,
  warn: (message: string) => void = console.warn,
): SitemapRows {
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    if (seen.has(row.url)) return false;
    seen.add(row.url);
    return true;
  });
  if (unique.length <= max) return unique;
  warn(`[sitemap] ${unique.length} URLs exceed the ${max} cap; the last ${unique.length - max} were dropped.`);
  return unique.slice(0, max);
}
