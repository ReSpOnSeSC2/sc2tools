import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, useMemo } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_BASE } from "@/lib/clientApi";
import { CommandSearchProvider } from "../CommandSearchProvider";
import { useCommandChrome, useCommandSearch, type CommandOpening } from "../CommandSearchContext";

const h = vi.hoisted(() => ({
  push: vi.fn(),
  auth: { userId: null as string | null, isLoaded: true, isSignedIn: false, getToken: vi.fn<() => Promise<string | null>>() },
  open: null as ((options?: CommandOpening) => void) | null,
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.auth }));
vi.mock("next/navigation", () => {
  const router = { push: h.push };
  return { usePathname: () => "/guides", useRouter: () => router, useSearchParams: () => new URLSearchParams("") };
});
// Guide availability comes from a fixed published set; every request the palette sends stays real.
vi.mock("@/lib/guides/flags", () => ({ guidesEnabled: () => true }));
vi.mock("@/lib/commandGuideMetadata", () => ({
  loadCommandGuideMetadata: async () => ({ publishedPaths: new Set(["/guides/pvz/counter/12-pool"]), maps: [] }),
}));

const BASE = API_BASE.replace(/\/+$/, "");
const fetching = vi.fn<typeof fetch>();
function respond(body: unknown, url: string) {
  const result = new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  Object.defineProperty(result, "url", { value: url });
  return result;
}
const community = (input: RequestInfo | URL) => String(input).startsWith(`${BASE}/v1/community/builds?`);
function Host() {
  const context = useCommandSearch()!;
  const chrome = useMemo(() => ({ ownerKey: context.ownerKey, navigation: [] }), [context.ownerKey]);
  useCommandChrome(chrome); useLayoutEffect(() => { h.open = context.open; }, [context.open]);
  return null;
}
async function open(options: CommandOpening) {
  render(<SWRConfig value={{ provider: () => new Map() }}><CommandSearchProvider><Host /></CommandSearchProvider></SWRConfig>);
  act(() => h.open!(options));
  return screen.findByRole("combobox", { name: options.scope === "guides" ? "Find a guide" : "Search" });
}
const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 260)));
beforeEach(() => {
  h.push.mockReset(); h.open = null; window.history.replaceState(null, "", "/guides");
  Object.assign(h.auth, { userId: null, isLoaded: true, isSignedIn: false });
  h.auth.getToken.mockReset().mockResolvedValue("token");
  fetching.mockReset().mockImplementation(async input => community(input)
    ? respond({ version: 1, hasMore: false, items: [{ slug: "build-a1", title: "Stargate opener", matchup: "PvZ", authorName: null, votes: 3 }] }, String(input))
    : respond({}, String(input)));
  vi.stubGlobal("fetch", fetching);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("public discovery privacy gates in the real palette", () => {
  it("sends Community's anonymous GET only after a signed-out edit, and links See all to /search", async () => {
    const input = await open({ query: "12 pool" });
    await settle();
    expect(fetching.mock.calls.filter(([url]) => community(url))).toHaveLength(0);
    fireEvent.change(input, { target: { value: "12 pool pvz" } });
    await screen.findByRole("option", { name: /^Stargate opener/ });
    const sent = fetching.mock.calls.filter(([url]) => community(url));
    expect(sent).toHaveLength(1);
    expect(String(sent[0][0])).toBe(`${BASE}/v1/community/builds?view=quick&limit=8&q=12+pool+pvz`);
    expect(sent[0][1]).toEqual(expect.objectContaining({ credentials: "omit", referrerPolicy: "no-referrer" }));
    expect(h.auth.getToken).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("option", { name: /^See all guide results/ }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/search?q=12%20pool%20pvz"));
  });

  it("never sends Community or offers See all for a signed-in viewer's all-pages query", async () => {
    Object.assign(h.auth, { userId: "A", isSignedIn: true });
    const input = await open({ query: "" });
    fireEvent.change(input, { target: { value: "12 pool pvz" } });
    // The published guide matches, so only the gate keeps See all away.
    expect((await screen.findAllByRole("option", { name: /12 pool/i })).length).toBeGreaterThan(0);
    await settle();
    expect(fetching.mock.calls.filter(([url]) => community(url))).toHaveLength(0);
    expect(screen.queryByRole("option", { name: /^See all guide results/ })).toBeNull();
    expect(screen.queryByRole("group", { name: "Community builds" })).toBeNull();
  });

  it("offers See all to a signed-in viewer in the Guides scope, still with no Community request", async () => {
    Object.assign(h.auth, { userId: "A", isSignedIn: true });
    const input = await open({ scope: "guides", query: "" });
    fireEvent.change(input, { target: { value: "12 pool pvz" } });
    expect(await screen.findByRole("option", { name: /^See all guide results/ })).toBeTruthy();
    await settle();
    expect(fetching.mock.calls.filter(([url]) => community(url))).toHaveLength(0);
  });

  it("treats a still-loading session as unknown: no Community request and no See all", async () => {
    Object.assign(h.auth, { isLoaded: false });
    const input = await open({ query: "" });
    fireEvent.change(input, { target: { value: "12 pool pvz" } });
    expect((await screen.findAllByRole("option", { name: /12 pool/i })).length).toBeGreaterThan(0);
    await settle();
    expect(fetching.mock.calls.filter(([url]) => community(url))).toHaveLength(0);
    expect(screen.queryByRole("option", { name: /^See all guide results/ })).toBeNull();
  });
});
