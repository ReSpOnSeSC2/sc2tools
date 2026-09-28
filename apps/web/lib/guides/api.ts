/**
 * Guide fetchers — SERVER ONLY (used by the /guides server components,
 * sitemap and generateMetadata; never import from a "use client"
 * module). Public, unauthenticated reads of `/v1/guides/*`.
 *
 * Unlike `lib/serverApi.ts` (null-or-data), every fetcher returns a
 * discriminated union so pages can pick the right HTTP semantics:
 *   - ok          → render the payload
 *   - moved       → permanentRedirect(path) (an alias slug; 301 on the API)
 *   - not_found   → notFound() (the API positively said 404, or the URL
 *                   segment can never be valid)
 *   - unavailable → network error, timeout, 429, 5xx, malformed JSON:
 *                   never a 404 for real content during an outage. Pages
 *                   rendered per request show the noindex "temporarily
 *                   unavailable" state; ISR pages throw instead, so the
 *                   outage is never cached (lib/guides/guideErrors.ts).
 *
 * Responses are kept in Next's data cache (`GUIDE_REVALIDATE_SEC`, 200s
 * only) under the "guides" tag, which `app/api/revalidate-guides` purges
 * after the nightly recompute. Within one server render every API path
 * is fetched at most once (React `cache`): the timeout `signal` opts each
 * call out of Next's built-in fetch dedupe, and without the memo a page's
 * generateMetadata and body would each hit the API on a cold cache.
 *
 * `server-only` is not imported: it is not a direct dependency of
 * apps/web and throws under vitest; the module follows the same
 * server-by-convention rule as `lib/serverApi.ts`.
 */
import { cache } from "react";
import { matchupFromGuideSlug } from "@/lib/guides/slugs";
import { guideBandQueryString, type GuideBandQuery } from "@/lib/guides/format";
import type {
  GuideBuildPayload,
  GuideCounterPayload,
  GuideEra,
  GuideIndexPayload,
  GuideMapPayload,
  GuideMatchupPayload,
  GuideSitemapPayload,
} from "@/lib/guides/types";

/** Same resolution order as lib/serverApi.ts. */
const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ||
  process.env.SC2TOOLS_API_BASE ||
  "http://localhost:8080";

/** ISR window for guide data (6 h); the nightly job also revalidates on demand. */
export const GUIDE_REVALIDATE_SEC = 21600;
/** Cache tag purged by the revalidate-guides route. */
export const GUIDE_CACHE_TAG = "guides";
/** Upper bound on one API call so a slow API can't hang page renders. */
export const GUIDE_FETCH_TIMEOUT_MS = 6000;

const API_GUIDES_PREFIX = "/v1/guides";
const SITE_GUIDES_PREFIX = "/guides";
/** Every guide URL segment (matchup, build, strategy, map slug). */
const SEGMENT_RE = /^[a-z0-9-]{1,80}$/;
/** A site guide path we are willing to redirect to (≤ 3 safe segments). */
const SITE_GUIDE_PATH_RE = /^\/guides(\/[a-z0-9-]{1,80}){1,3}$/;
const HTTP_NOT_FOUND = 404;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export type GuideFetchResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "moved"; path: string }
  | { kind: "not_found" }
  | { kind: "unavailable" };

const NOT_FOUND: { kind: "not_found" } = { kind: "not_found" };
const UNAVAILABLE: { kind: "unavailable" } = { kind: "unavailable" };

/** Band / era filters for the matchup page. */
export interface GuideMatchupQuery {
  band?: GuideBandQuery | null;
  era?: GuideEra;
}

function isSegment(value: unknown): value is string {
  return typeof value === "string" && SEGMENT_RE.test(value);
}

function isMatchupSegment(value: unknown): value is string {
  return isSegment(value) && matchupFromGuideSlug(value) !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(GUIDE_FETCH_TIMEOUT_MS)
    : undefined;
}

/**
 * Map an API redirect target ("/v1/guides/pvz/new-slug", relative or on
 * the API origin) or a body `movedTo` ("/guides/pvz/new-slug") onto a
 * site guide path. Anything else is refused (null) so an unexpected
 * Location can never become an open redirect.
 *
 * Example: `toSiteGuidePath("/v1/guides/pvz/new-slug")` → "/guides/pvz/new-slug".
 */
export function toSiteGuidePath(target: unknown): string | null {
  if (typeof target !== "string" || !target) return null;
  let pathname: string;
  try {
    const url = new URL(target, API_BASE);
    if (url.origin !== new URL(API_BASE).origin) return null;
    pathname = url.pathname;
  } catch {
    return null;
  }
  const sitePath = pathname.startsWith(`${API_GUIDES_PREFIX}/`)
    ? `${SITE_GUIDES_PREFIX}${pathname.slice(API_GUIDES_PREFIX.length)}`
    : pathname;
  return SITE_GUIDE_PATH_RE.test(sitePath) ? sitePath : null;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function movedResult<T>(res: Response): Promise<GuideFetchResult<T>> {
  const body = await readJson(res);
  const fromBody = isRecord(body) ? toSiteGuidePath(body.movedTo) : null;
  const path = fromBody ?? toSiteGuidePath(res.headers.get("location"));
  return path ? { kind: "moved", path } : UNAVAILABLE;
}

async function toResult<T>(res: Response): Promise<GuideFetchResult<T>> {
  if (REDIRECT_STATUSES.has(res.status)) return movedResult<T>(res);
  if (res.status === HTTP_NOT_FOUND) return NOT_FOUND;
  if (!res.ok) return UNAVAILABLE;
  const body = await readJson(res);
  // Shape is trusted beyond "is a JSON object": the API is first-party
  // and mirrored by lib/guides/types.ts.
  return isRecord(body) ? { kind: "ok", data: body as T } : UNAVAILABLE;
}

async function fetchGuideUncached<T>(apiPath: string): Promise<GuideFetchResult<T>> {
  try {
    const res = await fetch(`${API_BASE}${apiPath}`, {
      headers: { accept: "application/json" },
      next: { revalidate: GUIDE_REVALIDATE_SEC, tags: [GUIDE_CACHE_TAG] },
      redirect: "manual",
      signal: timeoutSignal(),
    });
    return await toResult<T>(res);
  } catch {
    return UNAVAILABLE;
  }
}

/**
 * `fetchGuideUncached`, memoised per server request by API path (React
 * `cache` is request-scoped on the server and a pass-through elsewhere).
 * Keyed on the full path string, so callers that build equal query
 * objects still share one call.
 */
const fetchGuide = cache(fetchGuideUncached);

/**
 * Guides hub payload (`GET /v1/guides`).
 *
 * Example: `const r = await fetchGuideIndex(); if (r.kind === "ok") r.data.matchups`.
 */
export function fetchGuideIndex(): Promise<GuideFetchResult<GuideIndexPayload>> {
  return fetchGuide<GuideIndexPayload>(API_GUIDES_PREFIX);
}

/**
 * Matchup page payload, optionally filtered by an opponent band / era.
 *
 * Example: `fetchGuideMatchup("pvz", { band: { type: "league", value: 4 } })`
 * → GET /v1/guides/pvz?band=league:4.
 */
export async function fetchGuideMatchup(
  matchupSlug: string,
  query: GuideMatchupQuery = {},
): Promise<GuideFetchResult<GuideMatchupPayload>> {
  if (!isMatchupSegment(matchupSlug)) return NOT_FOUND;
  const qs = guideBandQueryString(query.band ?? null, query.era);
  return fetchGuide<GuideMatchupPayload>(`${API_GUIDES_PREFIX}/${matchupSlug}${qs}`);
}

/**
 * Build guide payload (published or the number-free unpublished shape).
 *
 * Example: `fetchGuideBuild("pvz", "stargate-into-glaives")`.
 */
export async function fetchGuideBuild(
  matchupSlug: string,
  buildSlug: string,
): Promise<GuideFetchResult<GuideBuildPayload>> {
  if (!isMatchupSegment(matchupSlug) || !isSegment(buildSlug)) return NOT_FOUND;
  return fetchGuide<GuideBuildPayload>(`${API_GUIDES_PREFIX}/${matchupSlug}/${buildSlug}`);
}

/**
 * Counter page payload for an opponent strategy.
 *
 * Example: `fetchGuideCounter("pvz", "8-pool")` → GET /v1/guides/pvz/counter/8-pool.
 */
export async function fetchGuideCounter(
  matchupSlug: string,
  strategySlug: string,
): Promise<GuideFetchResult<GuideCounterPayload>> {
  if (!isMatchupSegment(matchupSlug) || !isSegment(strategySlug)) return NOT_FOUND;
  return fetchGuide<GuideCounterPayload>(
    `${API_GUIDES_PREFIX}/${matchupSlug}/counter/${strategySlug}`,
  );
}

/**
 * Map guide payload.
 *
 * Example: `fetchGuideMap("alcyone-le")` → GET /v1/guides/maps/alcyone-le.
 */
export async function fetchGuideMap(
  mapSlug: string,
): Promise<GuideFetchResult<GuideMapPayload>> {
  if (!isSegment(mapSlug)) return NOT_FOUND;
  return fetchGuide<GuideMapPayload>(`${API_GUIDES_PREFIX}/maps/${mapSlug}`);
}

/**
 * Published guide paths for app/sitemap.ts.
 *
 * Example: `fetchGuideSitemap()` → `{ kind: "ok", data: { entries: [{ path: "/guides", … }] } }`.
 */
export function fetchGuideSitemap(): Promise<GuideFetchResult<GuideSitemapPayload>> {
  return fetchGuide<GuideSitemapPayload>(`${API_GUIDES_PREFIX}/sitemap`);
}

/**
 * Paths of every guide page the API serves as published (the sitemap
 * list: same rule as the pages, so a listed path never renders "Not
 * enough games yet"). Pages use it to link only published pages when
 * their own payload carries no published flag for the target (a build's
 * best / toughest maps, a map's best openers). Null when the list can't
 * be read, so an API blip keeps a page's links instead of dropping all
 * of them.
 *
 * Example: `(await fetchPublishedGuidePaths())?.has("/guides/maps/old-sun-temple")` → true.
 */
export async function fetchPublishedGuidePaths(): Promise<ReadonlySet<string> | null> {
  const result = await fetchGuideSitemap();
  if (result.kind !== "ok" || !Array.isArray(result.data.entries)) return null;
  const paths = new Set<string>();
  for (const entry of result.data.entries) {
    if (typeof entry?.path === "string") paths.add(entry.path);
  }
  return paths;
}
