import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig, unstable_serialize } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ONBOARDING_PREFERENCES_PATH, TOURS, tourAvailabilityKey, tourStepsPresent, type TourAvailabilityScope, type TourId } from "@/lib/tours";
import { TakeATour } from "../TakeATour";

const auth = vi.hoisted(() => ({ owner: "owner-a" as string | null, loaded: true, getToken: vi.fn() }));
const navigation = vi.hoisted(() => ({ pathname: "/help/take-a-tour", search: "", push: vi.fn(), replace: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: auth.owner, isLoaded: auth.loaded, isSignedIn: !!auth.owner, getToken: auth.getToken }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
  usePathname: () => navigation.pathname, useSearchParams: () => new URLSearchParams(navigation.search) }));
// clientApi, its owner request scope, SWR and the widget are actual implementations.
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
/** Decode actual transport JSON before publishing the gate; abort cannot replace this stale DTO with a parse error. */
function heldJsonReply(value: unknown) {
  const response = reply(value), read = response.json.bind(response), gate = deferred<void>();
  let decoded = false;
  const parse = vi.fn(async () => { const captured: unknown = await read(); decoded = true; await gate.promise; return captured; });
  Object.defineProperty(response, "json", { value: parse });
  return { response, parse, hasDecoded: () => decoded, release: () => gate.resolve(undefined) };
}
type RequestRow = { owner: string; method: string; path: string; signal?: AbortSignal | null; cache?: RequestCache; body?: BodyInit | null };
let cache: Map<string, { data?: unknown }>;
let requests: RequestRow[];
let unknown: string[];
let transport: (owner: string, signal?: AbortSignal | null) => Promise<Response>;
function ui() { return <SWRConfig value={{ provider: () => cache, revalidateOnFocus: false, revalidateOnReconnect: false }}><TakeATour /></SWRConfig>; }
const gameButton = () => screen.getByRole("button", { name: "Replay game tour" });
function availability(owner: string, id: TourId, available: boolean, path = navigation.pathname, recordKey = "surface", current = () => true) {
  const scope: TourAvailabilityScope = { active: true, path, recordKey, current };
  cache.set(unstable_serialize(tourAvailabilityKey(owner, id)), { data: { available, scope } }); return scope;
}
function retireAndReturn(view: ReturnType<typeof render>, boundary: "owner" | "route") {
  if (boundary === "owner") auth.owner = "owner-b"; else navigation.pathname = "/settings";
  view.rerender(ui()); expect(gameButton()).toBeTruthy();
  if (boundary === "owner") auth.owner = "owner-a"; else navigation.pathname = "/help/take-a-tour";
  view.rerender(ui()); expect(gameButton()).toBeTruthy();
}

beforeEach(() => {
  auth.owner = "owner-a"; auth.loaded = true; auth.getToken.mockReset().mockImplementation(async () => auth.owner ? `jwt-${auth.owner}` : null);
  navigation.pathname = "/help/take-a-tour"; navigation.search = ""; navigation.push.mockReset(); navigation.replace.mockReset();
  cache = new Map(); requests = []; unknown = []; transport = async () => reply({ items: [{ gameId: "owned" }] });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)), path = url.pathname + url.search, method = init.method ?? "GET";
    if (path !== "/v1/games?limit=1" || method !== "GET" || init.body !== undefined) {
      unknown.push(`${method} ${path}`); throw new Error("Unadmitted tour-widget transport");
    }
    const owner = (new Headers(init.headers).get("authorization") ?? "").replace("Bearer jwt-", "");
    requests.push({ owner, method, path, signal: init.signal, cache: init.cache, body: init.body });
    return transport(owner, init.signal);
  }));
});
afterEach(async () => { cleanup(); await act(async () => {}); expect(unknown).toEqual([]); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("actual TakeATour Help widget", () => {
  it("does not read private data or request a token merely by mounting", async () => {
    render(ui()); await act(async () => {});
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(requests).toEqual([]); expect(auth.getToken).not.toHaveBeenCalled(); expect(navigation.push).not.toHaveBeenCalled();
  });

  it("waits for auth and offers only the real sign-in link while signed out", async () => {
    auth.loaded = false; const view = render(ui());
    expect(screen.getByRole("status").textContent).toBe("Loading tours…"); expect(screen.queryByRole("button")).toBeNull();
    auth.loaded = true; auth.owner = null; view.rerender(ui());
    expect(screen.getByRole("link", { name: "Sign in to take a tour" }).getAttribute("href")).toBe("/sign-in?redirect_url=%2Fhelp%2Ftake-a-tour");
    expect(screen.queryByRole("button")).toBeNull(); await act(async () => {});
    expect(requests).toEqual([]); expect(auth.getToken).not.toHaveBeenCalled();
  });

  it("replays Today and Overlay explicitly without reading or resetting saved versions", () => {
    const key = unstable_serialize(["authenticated-api", "owner-a", ONBOARDING_PREFERENCES_PATH]);
    const saved = { toursDone: { today: 1000, game: 1000, overlay: 1000 } }; cache.set(key, { data: saved });
    render(ui()); fireEvent.click(screen.getByRole("button", { name: "Replay Today tour" }));
    fireEvent.click(screen.getByRole("button", { name: "Replay Overlay tour" }));
    expect(navigation.push.mock.calls).toEqual([["/app?tour=today"], ["/settings?tab=overlay&tour=overlay"]]);
    expect(cache.get(key)?.data).toEqual(saved); expect(requests).toEqual([]); expect(auth.getToken).not.toHaveBeenCalled();
  });

  it("honors the same-route Help drawer's current false probe without reviving it across owner ABA", () => {
    navigation.pathname = "/app"; const present = new Set([TOURS.today.steps[0].target]);
    expect(tourStepsPresent("today", present)).toBeNull(); const scope = availability("owner-a", "today", false);
    const view = render(ui()); expect(screen.queryByRole("button", { name: "Replay Today tour" })).toBeNull();
    expect(gameButton()).toBeTruthy(); expect(screen.getByRole("button", { name: "Replay Overlay tour" })).toBeTruthy();
    auth.owner = "owner-b"; scope.active = false; view.rerender(ui()); expect(screen.getByRole("button", { name: "Replay Today tour" })).toBeTruthy();
    auth.owner = "owner-a"; view.rerender(ui()); expect(screen.getByRole("button", { name: "Replay Today tour" })).toBeTruthy();
    expect(requests).toEqual([]);
  });

  it("ignores old surface failures in full Help and can resolve the latest owned game", async () => {
    availability("owner-a", "today", false, "/app"); availability("owner-a", "game", false, "/app/game/old", "old");
    availability("owner-a", "overlay", false, "/settings"); transport = async () => reply({ items: [{ gameId: "latest-owned" }] });
    render(ui()); expect(screen.getAllByRole("button")).toHaveLength(3);
    fireEvent.click(gameButton()); await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/app/game/latest-owned?tour=game"));
    expect(requests).toHaveLength(1); expect(requests[0].owner).toBe("owner-a");
  });

  it("does not let an old record's false probe poison Help, the next record, or a record ABA return", async () => {
    let generation = 1; navigation.pathname = "/app/game/one";
    const first = availability("owner-a", "game", false, navigation.pathname, "one", () => generation === 1);
    const gameKey = unstable_serialize(tourAvailabilityKey("owner-a", "game")), firstValue = cache.get(gameKey)?.data;
    const view = render(ui()); expect(screen.queryByRole("button", { name: "Replay game tour" })).toBeNull();
    generation = 2; first.active = false; navigation.pathname = "/help/take-a-tour"; view.rerender(ui()); expect(gameButton()).toBeTruthy();
    generation = 3; navigation.pathname = "/app/game/two";
    const second = availability("owner-a", "game", false, navigation.pathname, "two", () => generation === 3);
    view.rerender(ui()); expect(screen.queryByRole("button", { name: "Replay game tour" })).toBeNull();
    generation = 4; second.active = false; cache.set(gameKey, { data: firstValue }); navigation.pathname = "/app/game/one";
    view.rerender(ui()); expect(gameButton()).toBeTruthy();
    transport = async () => reply({ items: [{ gameId: "fresh-record" }] }); fireEvent.click(gameButton());
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/app/game/fresh-record?tour=game")); expect(requests).toHaveLength(1);
  });

  it("resolves one owned replay only after explicit action, locks duplicate clicks and encodes its ID", async () => {
    const held = deferred<Response>(); transport = () => held.promise; render(ui()); const button = gameButton();
    fireEvent.click(button); fireEvent.click(button); await waitFor(() => expect(requests).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Opening…" }).hasAttribute("disabled")).toBe(true);
    expect(navigation.push).not.toHaveBeenCalled();
    const gameId = "2026-10-26|A/B?C|Map"; await act(async () => held.resolve(reply({ items: [{ gameId }] })));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith(`/app/game/${encodeURIComponent(gameId)}?tour=game`));
    expect(requests.map(({ owner, method, path, cache: policy, body }) => ({ owner, method, path, policy, body })))
      .toEqual([{ owner: "owner-a", method: "GET", path: "/v1/games?limit=1", policy: "no-store", body: undefined }]);
    expect(auth.getToken).toHaveBeenCalledTimes(1); expect(navigation.push).toHaveBeenCalledTimes(1);
  });

  it("does not navigate for missing, malformed or invalid owned replay answers", async () => {
    render(ui());
    const answers = [null, {}, { items: [] }, { items: "wrong" }, { items: [{ gameId: 7 }] },
      { items: [{ gameId: "" }] }, { items: [{ gameId: "  " }] }, { items: [{ gameId: "bad\nkey" }] }, { items: [{ gameId: "x".repeat(1025) }] }];
    for (const [index, value] of answers.entries()) {
      transport = async () => reply(value); fireEvent.click(gameButton());
      await waitFor(() => expect(requests).toHaveLength(index + 1));
      await waitFor(() => expect(gameButton().hasAttribute("disabled")).toBe(false));
      expect(await screen.findByRole("alert")).toBeTruthy(); expect(navigation.push).not.toHaveBeenCalled();
    }
  });

  it("keeps an error recoverable and resolves a fresh replay after an explicit retry", async () => {
    transport = vi.fn().mockResolvedValueOnce(reply({ error: { code: "unavailable" } }, 503))
      .mockResolvedValueOnce(reply({ items: [{ gameId: "after-retry" }] }));
    render(ui()); fireEvent.click(gameButton()); expect(await screen.findByRole("alert")).toBeTruthy();
    expect(navigation.push).not.toHaveBeenCalled(); fireEvent.click(gameButton());
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/app/game/after-retry?tour=game"));
    expect(requests).toHaveLength(2); expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["owner", "route"] as const)("retires a held JWT across a %s A→B→A boundary before any private read", async boundary => {
    const held = deferred<string>(); auth.getToken.mockImplementationOnce(() => held.promise);
    const view = render(ui()); fireEvent.click(gameButton()); await waitFor(() => expect(auth.getToken).toHaveBeenCalledTimes(1));
    retireAndReturn(view, boundary); await act(async () => held.resolve("jwt-owner-a"));
    expect(requests).toEqual([]); expect(navigation.push).not.toHaveBeenCalled(); expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(gameButton()); await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/app/game/owned?tour=game"));
    expect(requests).toHaveLength(1);
  });

  it.each(["owner", "route"] as const)("rejects a decoded held body across a %s A→B→A boundary", async boundary => {
    const held = heldJsonReply({ items: [{ gameId: "stale-game" }] }); transport = async () => held.response;
    const view = render(ui()); fireEvent.click(gameButton()); await waitFor(() => expect(held.hasDecoded()).toBe(true));
    expect(held.parse).toHaveBeenCalledTimes(1);
    retireAndReturn(view, boundary); await waitFor(() => expect(requests[0].signal?.aborted).toBe(true));
    await act(async () => held.release());
    expect(navigation.push).not.toHaveBeenCalled(); expect(screen.queryByRole("alert")).toBeNull();
    transport = async () => reply({ items: [{ gameId: "fresh-game" }] }); fireEvent.click(gameButton());
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/app/game/fresh-game?tour=game")); expect(requests).toHaveLength(2);
  });

  it("does not navigate from a held decoded body after the Help widget unmounts", async () => {
    const held = heldJsonReply({ items: [{ gameId: "late-game" }] }); transport = async () => held.response;
    const view = render(ui()); fireEvent.click(gameButton()); await waitFor(() => expect(held.hasDecoded()).toBe(true));
    view.unmount(); await waitFor(() => expect(requests[0].signal?.aborted).toBe(true));
    await act(async () => held.release()); expect(navigation.push).not.toHaveBeenCalled();
  });

  it("retires a held JWT when auth becomes loading and does not navigate after it returns", async () => {
    const held = deferred<string>(); auth.getToken.mockImplementationOnce(() => held.promise);
    const view = render(ui()); fireEvent.click(gameButton()); await waitFor(() => expect(auth.getToken).toHaveBeenCalledTimes(1));
    auth.loaded = false; view.rerender(ui()); expect(screen.getByRole("status")).toBeTruthy();
    await act(async () => held.resolve("jwt-owner-a")); expect(requests).toEqual([]); expect(navigation.push).not.toHaveBeenCalled();
    auth.loaded = true; view.rerender(ui()); expect(gameButton()).toBeTruthy(); expect(screen.queryByRole("alert")).toBeNull();
  });
});
