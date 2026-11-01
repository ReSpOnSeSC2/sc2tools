import { afterEach, describe, expect, it, vi } from "vitest";
import { API_BASE } from "../clientApi";
import { commandActivationPolicy } from "../commandSearchActivation";
import { PrivateCommandSearchError } from "../privateCommandSearch";
import {
  COMMUNITY_COMMAND_BYTES, communityCommandItems, communityCommandUrl, decodeCommunityCommandSearch, requestCommunityCommandSearch,
} from "../communityCommandSearch";

const BASE = API_BASE.replace(/\/+$/, "");
const row = (slug: string, votes = 5, extra: Record<string, unknown> = {}) =>
  ({ slug, title: `Build ${slug}`, matchup: "PvZ", authorName: "Author", votes, ...extra });
const wire = (items: unknown[], hasMore = false) => ({ version: 1, items, hasMore });
function response(body: unknown, url: string, init: ResponseInit & { redirected?: boolean } = {}) {
  const result = new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
  Object.defineProperty(result, "url", { value: url });
  if (init.redirected) Object.defineProperty(result, "redirected", { value: true });
  return result;
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("signed-out Community quick search wire", () => {
  it("decodes the exact slim rows and builds each href locally", () => {
    const decoded = decodeCommunityCommandSearch(wire([row("build-a1", 9), row("old.slug", 9, { matchup: null, authorName: null })]));
    expect(communityCommandItems(decoded)).toEqual([
      { id: "community:build-a1", group: "community-builds", label: "Build build-a1", description: "Community build by Author",
        href: "/community/builds/build-a1", matchup: "PvZ" },
      { id: "community:old.slug", group: "community-builds", label: "Build old.slug", description: "Community build",
        href: "/community/builds/old.slug" },
    ]);
  });
  it.each([
    ["an extra root key", { ...wire([]), total: 3 }],
    ["another version", { ...wire([]), version: 2 }],
    ["an extra row key", wire([{ ...row("a1"), description: "x" }])],
    ["a slug outside the grammar", wire([row("../admin")])],
    ["a blank title", wire([row("a1", 5, { title: "   " })])],
    ["a control in a title", wire([row("a1", 5, { title: "Bad\u0007title" })])],
    ["a strange matchup", wire([row("a1", 5, { matchup: "PvAny" })])],
    ["rising votes", wire([row("a1", 1), row("a2", 2)])],
    ["a repeated slug", wire([row("a1"), row("a1")])],
    ["more than eight rows", wire(Array.from({ length: 9 }, (_, index) => row(`a${index}`)))],
    ["hasMore without eight rows", wire([row("a1")], true)],
  ])("fails closed on %s", (_label, value) => {
    expect(() => decodeCommunityCommandSearch(value)).toThrow(PrivateCommandSearchError);
  });
  it("sends one anonymous GET with no credentials, referrer or redirects", async () => {
    const url = communityCommandUrl("zerg rush"), fetching = vi.fn<typeof fetch>(async () => response(wire([row("a1")]), url));
    vi.stubGlobal("fetch", fetching);
    expect(url).toBe(`${BASE}/v1/community/builds?view=quick&limit=8&q=zerg+rush`);
    const result = await requestCommunityCommandSearch("zerg rush", new AbortController().signal);
    expect(result.items.map(item => item.slug)).toEqual(["a1"]);
    const [target, init] = fetching.mock.calls[0];
    expect(target).toBe(url);
    expect(init).toEqual(expect.objectContaining({ method: "GET", credentials: "omit", cache: "no-store", redirect: "error",
      referrerPolicy: "no-referrer", headers: { accept: "application/json" } }));
  });
  it.each([
    ["a failed status", (url: string) => response({}, url, { status: 429 }), "unavailable"],
    ["a moved URL", () => response(wire([]), `${BASE}/v1/elsewhere`), "invalid_response"],
    ["a redirect", (url: string) => response(wire([]), url, { redirected: true }), "invalid_response"],
    ["an oversize declared body", (url: string) => response(wire([]), url,
      { headers: { "content-type": "application/json", "content-length": String(COMMUNITY_COMMAND_BYTES + 1) } }), "response_too_large"],
  ])("refuses %s", async (_label, make, code) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => make(communityCommandUrl("zerg"))));
    await expect(requestCommunityCommandSearch("zerg", new AbortController().signal)).rejects.toMatchObject({ code });
  });
  it("stops reading a streamed body past 32 KiB when no length is declared", async () => {
    const url = communityCommandUrl("zerg"), chunk = new Uint8Array(16 * 1024).fill(0x20);
    let pulls = 0;
    const streamed = new Response(new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.enqueue(chunk); } }),
      { status: 200, headers: { "content-type": "application/json" } });
    Object.defineProperty(streamed, "url", { value: url });
    expect(streamed.headers.get("content-length")).toBeNull();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => streamed));
    await expect(requestCommunityCommandSearch("zerg", new AbortController().signal)).rejects.toMatchObject({ code: "response_too_large" });
    expect(pulls).toBeLessThanOrEqual(4);
  });
  it("sends nothing for an invalid query", async () => {
    const fetching = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetching);
    await expect(requestCommunityCommandSearch("z", new AbortController().signal)).rejects.toMatchObject({ code: "invalid_query" });
    expect(fetching).not.toHaveBeenCalled();
  });
  it("admits a Community row only for a signed-out viewer and only to a build page", () => {
    const [item] = communityCommandItems(decodeCommunityCommandSearch(wire([row("build-a1")])));
    expect(commandActivationPolicy.admitsItem(item, null, null)).toBe(true);
    expect(commandActivationPolicy.admitsItem(item, null, "user_a")).toBe(false);
    expect(commandActivationPolicy.admitsItem({ ...item, href: "/settings" }, null, null)).toBe(false);
    expect(commandActivationPolicy.admitsItem({ ...item, href: "/community/builds/a/b" }, null, null)).toBe(false);
  });
});
