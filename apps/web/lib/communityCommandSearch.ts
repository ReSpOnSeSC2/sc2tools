import type { CommandSearchItem } from "./commandSearch";
import {
  PrivateCommandSearchError, abortable, apiEndpoint, boundedJson, cancelBody, privateCommandQuery, safeText,
} from "./privateCommandSearch";

// Community builds in the signed-out palette (ADR 0069, 2026-11-01 amendment):
// one anonymous GET /v1/community/builds?view=quick per settled, explicitly
// typed query. This leaf belongs to the intent-loaded command runtime and keeps
// no cache, storage, analytics or navigation.
export const COMMUNITY_COMMAND_PATH = "/v1/community/builds";
export const COMMUNITY_COMMAND_LIMIT = 8;
export const COMMUNITY_COMMAND_BYTES = 32 * 1024;
export const COMMUNITY_COMMAND_DEBOUNCE_MS = 200;
export const COMMUNITY_COMMAND_TIMEOUT_MS = 5_000;
/** The web sitemap's community slug grammar: build-<hex>, or a legacy slug that may hold dots. */
export const COMMUNITY_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const COMMUNITY_HREF = /^\/community\/builds\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type CommunityCommandBuild = Readonly<{
  slug: string; title: string; matchup: string | null; authorName: string | null; votes: number;
}>;
export type CommunityCommandResponse = Readonly<{ items: readonly CommunityCommandBuild[]; hasMore: boolean }>;

const invalid = (): never => { throw new PrivateCommandSearchError("invalid_response"); };
const abortError = () => new DOMException("Community search is no longer current.", "AbortError");

/** The private search's literal rule: outer trim only, 2-80 code points, no controls. */
export const communityCommandQuery = privateCommandQuery;

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return invalid();
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid();
    copy[key] = descriptor.value;
  }
  return copy;
}
function build(value: unknown): CommunityCommandBuild {
  const row = exact(value, ["slug", "title", "matchup", "authorName", "votes"]);
  if (typeof row.slug !== "string" || !COMMUNITY_SLUG.test(row.slug) || !safeText(row.title, 200) || !row.title.trim()) return invalid();
  if (row.matchup !== null && (typeof row.matchup !== "string" || !/^[PTZR]v[PTZR]$/.test(row.matchup))) return invalid();
  if (row.authorName !== null && !safeText(row.authorName, 80)) return invalid();
  if (!Number.isSafeInteger(row.votes)) return invalid();
  return Object.freeze({ slug: row.slug, title: row.title, matchup: row.matchup as string | null,
    authorName: row.authorName as string | null, votes: row.votes as number });
}

/** Strict version 1: exact keys, at most eight unique rows, votes never rising, and hasMore only with eight. */
export function decodeCommunityCommandSearch(value: unknown): CommunityCommandResponse {
  const root = exact(value, ["version", "items", "hasMore"]);
  if (root.version !== 1 || typeof root.hasMore !== "boolean" || !Array.isArray(root.items)
    || Object.getPrototypeOf(root.items) !== Array.prototype || root.items.length > COMMUNITY_COMMAND_LIMIT) return invalid();
  const list = root.items as unknown[];
  const items = Array.from({ length: list.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
    return descriptor && Object.hasOwn(descriptor, "value") ? build(descriptor.value) : invalid();
  });
  if (new Set(items.map(item => item.slug)).size !== items.length
    || items.some((item, index) => index > 0 && item.votes > items[index - 1].votes)
    || (root.hasMore && items.length !== COMMUNITY_COMMAND_LIMIT)) return invalid();
  return Object.freeze({ items: Object.freeze(items), hasMore: root.hasMore });
}

/** Palette rows; each href is built here from a validated slug. */
export function communityCommandItems(response: CommunityCommandResponse): readonly CommandSearchItem[] {
  return Object.freeze(response.items.map(item => Object.freeze({
    id: `community:${item.slug}`, group: "community-builds" as const, label: item.title,
    description: item.authorName ? `Community build by ${item.authorName}` : "Community build",
    href: `/community/builds/${encodeURIComponent(item.slug)}`, ...(item.matchup ? { matchup: item.matchup } : {}),
  })));
}

/** Example: communityCommandUrl("stargate") → "<API>/v1/community/builds?view=quick&limit=8&q=stargate". */
export function communityCommandUrl(query: string): string {
  const url = new URL(apiEndpoint(COMMUNITY_COMMAND_PATH));
  url.search = new URLSearchParams([["view", "quick"], ["limit", String(COMMUNITY_COMMAND_LIMIT)], ["q", query]]).toString();
  return url.href;
}

/** Anonymous: no credentials, Authorization or referrer; redirects denied; the final URL and type verified. */
export async function requestCommunityCommandSearch(query: string, signal: AbortSignal): Promise<CommunityCommandResponse> {
  let response: Response | undefined;
  try {
    if (communityCommandQuery(query) !== query) throw new PrivateCommandSearchError("invalid_query");
    const url = communityCommandUrl(query);
    response = await abortable(fetch(url, {
      method: "GET", headers: { accept: "application/json" }, credentials: "omit", cache: "no-store",
      redirect: "error", referrerPolicy: "no-referrer", signal,
    }), signal, cancelBody);
    if (response.status !== 200) throw new PrivateCommandSearchError("unavailable");
    if (response.redirected || response.url !== url
      || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return invalid();
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) return invalid();
    if (length !== null && Number(length) > COMMUNITY_COMMAND_BYTES) throw new PrivateCommandSearchError("response_too_large");
    return decodeCommunityCommandSearch(await boundedJson(response, signal, () => {
      if (signal.aborted) throw abortError();
    }, COMMUNITY_COMMAND_BYTES));
  } catch (error) {
    if (response && !response.body?.locked) cancelBody(response);
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
    if (error instanceof PrivateCommandSearchError) throw error;
    // Never expose a response body, URL, query or exception text.
    throw new PrivateCommandSearchError("unavailable");
  }
}
