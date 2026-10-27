import { useRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig, unstable_serialize } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuidedTours } from "./GuidedTours";
import { Modal } from "@/components/ui/Modal";
import { ONBOARDING_PREFERENCES_PATH, TOURS, tourAvailabilityKey, tourIsDone, tourUnavailable, tourVersions, type TourAvailability, type TourId } from "@/lib/tours";

const auth = vi.hoisted(() => ({ owner: "owner-a" as string | null, loaded: true, getToken: vi.fn() }));
const nav = vi.hoisted(() => ({ pathname: "/app", search: "", listeners: new Set<() => void>(), push: vi.fn(), replace: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: auth.owner, isLoaded: auth.loaded, isSignedIn: !!auth.owner, getToken: auth.getToken }) }));
vi.mock("next/dynamic", async () => {
  const { lazy } = await import("react");
  // Load the actual controller through the real dynamic import, not a substitute.
  return { default: (loader: () => Promise<import("react").ComponentType>) => lazy(async () => ({ default: await loader() })) };
});
vi.mock("next/navigation", async () => {
  const { useMemo, useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => { nav.listeners.add(listener); return () => { nav.listeners.delete(listener); }; };
  const snapshot = () => nav.pathname + "?" + nav.search;
  const router = { push: nav.push, replace: (href: string, options?: { scroll?: boolean }) => {
    nav.replace(href, options); const url = new URL(href, window.location.href);
    nav.pathname = url.pathname; nav.search = url.search.slice(1); window.history.replaceState(null, "", href);
    for (const listener of nav.listeners) listener();
  } };
  return { useRouter: () => router,
    usePathname: () => { useSyncExternalStore(subscribe, snapshot, snapshot); return nav.pathname; },
    useSearchParams: () => { const key = useSyncExternalStore(subscribe, snapshot, snapshot); return useMemo(() => new URLSearchParams(key.slice(key.indexOf("?") + 1)), [key]); } };
});

type Prefs = Record<string, unknown> & { toursDone?: unknown };
type Write = { owner: string; body: { toursDone: Record<string, number> }; signal?: AbortSignal | null };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function heldJson(value: unknown) {
  const response = reply(value), read = response.json.bind(response), gate = deferred<void>(); let decoded = false;
  Object.defineProperty(response, "json", { value: async () => { const captured: unknown = await read(); decoded = true; await gate.promise; return captured; } });
  return { response, decoded: () => decoded, release: () => gate.resolve(undefined) };
}
let cache: Map<string, { data?: unknown }>;
let answers: Map<string, Prefs>;
let reads: { owner: string; signal?: AbortSignal | null }[];
let writes: Write[];
let unexpected: string[];
let get: (owner: string) => Promise<Response>;
let put: (owner: string, body: Write["body"]) => Promise<Response>;
let fixture: { id: TourId; record: string; ready: boolean; previous: boolean; targets: string[]; dialog: boolean; checkin: string | null };
let bodyObservations: number;
let activeBodyObservers: Set<MutationObserver>;
let resizeObservers: number;
let scroll: ReturnType<typeof vi.fn>;
let addListener: { mock: { calls: unknown[][] } };
let frames: Map<number, ReturnType<typeof setTimeout>>;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
const originalFullscreen = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
let fullscreen: Element | null;
function setFullscreen(element: Element | null) { fullscreen = element; fireEvent(document, new Event("fullscreenchange")); }
const key = (owner = "owner-a") => unstable_serialize(["authenticated-api", owner, ONBOARDING_PREFERENCES_PATH]);
const panel = () => document.querySelector<HTMLElement>("[data-tour-dialog]");
const saved = (owner = "owner-a", id: TourId = fixture.id) => tourIsDone(id, (cache.get(key(owner))?.data as Prefs | undefined)?.toursDone);
function setRoute(pathname: string, search = "") {
  nav.pathname = pathname; nav.search = search; window.history.replaceState(null, "", pathname + (search ? "?" + search : ""));
  for (const listener of nav.listeners) listener();
}
function Fixture() {
  const editing = useRef<HTMLButtonElement>(null);
  return <><button data-testid="reading-focus">Reading focus</button>
    <GuidedTours id={fixture.id} ready={fixture.ready && !fixture.previous} recordKey={fixture.record} isCurrent={() => !fixture.previous}>
      {TOURS[fixture.id].steps.filter(step => fixture.targets.includes(step.target)).map(step =>
        <section key={step.target} data-tour={step.target}><h2>{step.target}</h2><button>{step.target} control</button></section>)}
    </GuidedTours>
    <Modal open={fixture.dialog} onClose={() => {}} title="Existing page controls" initialFocusRef={editing}><button ref={editing}>Keep editing</button></Modal>
    {fixture.checkin ? <div data-tour-blocker="check-in" data-testid="marked-checkin"><p>{fixture.checkin}</p><button>Check-in control</button></div> : null}
  </>;
}
function ui() { return <SWRConfig value={{ provider: () => cache, revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false }}><Fixture /></SWRConfig>; }
async function opened() { await waitFor(() => expect(panel()).not.toBeNull()); return panel()!; }
async function settled() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function toLastStep() {
  for (let index = 1; index < fixture.targets.length; index++) {
    fireEvent.click(within(await opened()).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(panel()?.textContent).toContain(`Step ${index + 1} of ${fixture.targets.length}`));
  }
}
async function aba(view: ReturnType<typeof render>, boundary: "owner" | "route" | "record") {
  await act(async () => {
    if (boundary === "owner") auth.owner = "owner-b";
    else if (boundary === "record") { fixture.record = "two"; setRoute("/app/game/two"); }
    else setRoute("/app");
    view.rerender(ui());
  });
  await act(async () => {
    if (boundary === "owner") auth.owner = "owner-a";
    else { fixture.record = "one"; setRoute("/app/game/one"); }
    view.rerender(ui());
  });
  await opened();
}
function gameSurface() { fixture.id = "game"; fixture.record = "one"; fixture.targets = TOURS.game.steps.map(step => step.target); setRoute("/app/game/one"); }

beforeEach(() => {
  auth.owner = "owner-a"; auth.loaded = true; auth.getToken.mockReset().mockImplementation(async () => `jwt-${auth.owner}`);
  nav.push.mockReset(); nav.replace.mockReset(); setRoute("/app");
  fixture = { id: "today", record: "surface", ready: true, previous: false, targets: TOURS.today.steps.map(step => step.target), dialog: false, checkin: null };
  cache = new Map(); answers = new Map([["owner-a", { goals: ["improve"], futureField: "$literal-data" }], ["owner-b", { toursDone: { today: 1, game: 1, overlay: 1 } }]]);
  reads = []; writes = []; unexpected = [];
  fullscreen = null; Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen });
  get = async owner => reply(answers.get(owner) ?? {});
  // Independent read answers isolate client ACK admission; these fixtures do not model server consistency.
  put = async (owner, body) => reply({ ...answers.get(owner), toursDone: { ...tourVersions(answers.get(owner)?.toursDone), ...body.toursDone } });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)), method = init.method ?? "GET";
    const owner = (new Headers(init.headers).get("authorization") ?? "").replace("Bearer jwt-", "");
    if (url.pathname === ONBOARDING_PREFERENCES_PATH && !url.search && method === "GET") { reads.push({ owner, signal: init.signal }); return get(owner); }
    if (url.pathname === ONBOARDING_PREFERENCES_PATH && !url.search && method === "PUT") {
      const body = JSON.parse(String(init.body)); writes.push({ owner, body, signal: init.signal }); return put(owner, body);
    }
    unexpected.push(`${method} ${url.pathname}${url.search}`); throw new Error("Unadmitted controller transport");
  }));
  scroll = vi.fn(); Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const visible = this.isConnected && !this.closest("[hidden],[inert],[aria-hidden='true']");
    return { x: 40, y: 80, left: 40, top: 80, right: visible ? 320 : 40, bottom: visible ? 180 : 80,
      width: visible ? 280 : 0, height: visible ? 100 : 0, toJSON: () => ({}) } as DOMRect;
  });
  vi.stubGlobal("matchMedia", vi.fn((media: string) => ({ media, matches: media.includes("prefers-reduced-motion"), onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })));
  resizeObservers = 0;
  vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { void callback; resizeObservers++; } observe() {} unobserve() {} disconnect() {} });
  frames = new Map(); let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, setTimeout(() => { frames.delete(id); callback(0); }, 0)); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { clearTimeout(frames.get(id)); frames.delete(id); });
  bodyObservations = 0; activeBodyObservers = new Set();
  const observe = MutationObserver.prototype.observe, disconnect = MutationObserver.prototype.disconnect;
  vi.spyOn(MutationObserver.prototype, "observe").mockImplementation(function (this: MutationObserver, target: Node, options?: MutationObserverInit) {
    if (target === document.body) { bodyObservations++; activeBodyObservers.add(this); } return observe.call(this, target, options);
  });
  vi.spyOn(MutationObserver.prototype, "disconnect").mockImplementation(function (this: MutationObserver) { activeBodyObservers.delete(this); return disconnect.call(this); });
  addListener = vi.spyOn(window, "addEventListener");
});
afterEach(async () => {
  cleanup(); await settled();
  try { expect(activeBodyObservers.size).toBe(0); expect(nav.listeners.size).toBe(0); expect(document.body.style.overflow).not.toBe("hidden"); expect(unexpected).toEqual([]); }
  finally {
    for (const timer of frames.values()) clearTimeout(timer); frames.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll); else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    if (originalFullscreen) Object.defineProperty(document, "fullscreenElement", originalFullscreen); else Reflect.deleteProperty(document, "fullscreenElement");
  }
});

describe("actual guided-tour controller with synthetic owned targets", () => {
  it("automatically opens unsaved Today with one preferences GET, no games read, and does not block on its own portal", async () => {
    render(ui()); screen.getByTestId("reading-focus").focus(); const tour = await opened();
    expect(reads.map(row => row.owner)).toEqual(["owner-a"]); expect(writes).toEqual([]);
    expect(tour.getAttribute("role")).toBe("dialog"); expect(tour.getAttribute("aria-modal")).toBe("true");
    expect(tour.closest("[data-tour-overlay]")).toBeTruthy(); expect(tour.contains(document.activeElement)).toBe(true);
    fireEvent.resize(window); await settled(); expect(panel()).toBe(tour);
    const next = within(tour).getByRole("button", { name: "Next" }); next.focus(); fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(within(tour).getByRole("button", { name: "Skip tour" }));
    expect(scroll).not.toHaveBeenCalled();
  });

  it.each(["skip", "finish"] as const)("saves %s only after the exact tour version is acknowledged", async how => {
    const held = deferred<Response>(); put = () => held.promise; render(ui()); await opened(); if (how === "finish") await toLastStep();
    fireEvent.click(within(panel()!).getByRole("button", { name: how === "skip" ? "Skip tour" : "Finish" }));
    await waitFor(() => expect(writes).toHaveLength(1)); expect(writes[0].body).toEqual({ toursDone: { today: TOURS.today.version } });
    expect(panel()).not.toBeNull(); expect(saved()).toBe(false); expect(within(panel()!).getByRole("button", { name: "Saving…" }).getAttribute("aria-disabled")).toBe("true");
    await act(async () => held.resolve(reply({ futureField: "$literal-data", toursDone: { today: TOURS.today.version } })));
    await waitFor(() => expect(panel()).toBeNull()); expect(saved()).toBe(true); expect(reads).toHaveLength(1);
    expect((cache.get(key())?.data as Prefs).futureField).toBe("$literal-data");
  });

  it.each(["malformed200", "error503"] as const)("retains the tour/cache and permits explicit retry after %s", async failure => {
    put = vi.fn().mockResolvedValueOnce(failure === "malformed200" ? reply({ toursDone: { today: "1" } }) : reply({ error: { code: "unavailable" } }, 503))
      .mockResolvedValueOnce(reply({ toursDone: { today: TOURS.today.version } }));
    render(ui()); fireEvent.click(within(await opened()).getByRole("button", { name: "Skip tour" }));
    expect(await screen.findByRole("alert")).toBeTruthy(); expect(panel()).not.toBeNull(); expect(saved()).toBe(false);
    fireEvent.click(within(panel()!).getByRole("button", { name: "Skip tour" }));
    await waitFor(() => expect(panel()).toBeNull()); expect(writes).toHaveLength(2); expect(saved()).toBe(true); expect(reads).toHaveLength(1);
  });

  it("does not observe body, scroll or resize for saved progress until an explicit replay", async () => {
    answers.set("owner-a", { toursDone: { today: TOURS.today.version } }); render(ui());
    await waitFor(() => expect(saved()).toBe(true)); await settled();
    expect(panel()).toBeNull(); expect(bodyObservations).toBe(0); expect(resizeObservers).toBe(0);
    expect(addListener.mock.calls.filter(call => call[0] === "scroll" || call[0] === "resize")).toEqual([]); expect(scroll).not.toHaveBeenCalled();
    await act(async () => setRoute("/app", "tour=today")); await opened();
    expect(bodyObservations).toBeGreaterThan(0); expect(resizeObservers).toBeGreaterThan(0); expect(writes).toEqual([]);
    expect(nav.replace).toHaveBeenCalledWith("/app", { scroll: false }); expect(saved()).toBe(true);
  });

  it("refuses more than half missing and publishes unavailable without focusing or saving", async () => {
    fixture.targets = [TOURS.today.steps[0].target]; setRoute("/app", "tour=today"); render(ui()); const reading = screen.getByTestId("reading-focus"); reading.focus();
    await screen.findByText("This tour is unavailable for the current layout.");
    const value = cache.get(unstable_serialize(tourAvailabilityKey("owner-a", "today")))?.data;
    expect(value).toMatchObject({ available: false, scope: { active: true, path: "/app", recordKey: "surface" } });
    expect(tourUnavailable(value, "/app")).toBe(true);
    expect(panel()).toBeNull(); expect(document.activeElement).toBe(reading); expect(scroll).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });

  it("retires only its old record probe across Help, the next record and record ABA without clearing a newer value", async () => {
    gameSurface(); fixture.targets = [TOURS.game.steps[0].target];
    const probeKey = unstable_serialize(tourAvailabilityKey("owner-a", "game"));
    const probe = () => cache.get(probeKey)?.data as TourAvailability | undefined;
    const view = render(ui()); await waitFor(() => expect(probe()?.available).toBe(false)); const first = probe()!;
    expect(first.scope).toMatchObject({ active: true, path: "/app/game/one", recordKey: "one" }); expect(first.scope.current()).toBe(true);
    await act(async () => { setRoute("/help/take-a-tour"); view.rerender(ui()); }); await settled();
    expect(first.scope.active).toBe(false); expect(first.scope.current()).toBe(false); expect(probe()).toBe(first);
    expect(tourUnavailable(first, "/help/take-a-tour")).toBe(false);
    await act(async () => { fixture.record = "two"; fixture.targets = TOURS.game.steps.map(step => step.target); setRoute("/app/game/two"); view.rerender(ui()); });
    await opened(); await waitFor(() => expect(probe()?.available).toBe(true)); const second = probe()!;
    expect(second.scope).toMatchObject({ active: true, path: "/app/game/two", recordKey: "two" }); expect(second.scope).not.toBe(first.scope);
    await settled(); expect(probe()).toBe(second); expect(first.scope.active).toBe(false);
    await act(async () => { fixture.record = "one"; fixture.targets = [TOURS.game.steps[0].target]; setRoute("/app/game/one"); view.rerender(ui()); });
    await waitFor(() => expect(probe()?.available).toBe(false)); const returned = probe()!;
    expect(returned.scope).not.toBe(first.scope); expect(second.scope.active).toBe(false);
    expect(tourUnavailable(first, "/app/game/one")).toBe(false); expect(tourUnavailable(returned, "/app/game/one")).toBe(true);
    view.unmount(); expect(returned.scope.active).toBe(false); expect(probe()).toBe(returned);
    expect(tourUnavailable(returned, "/help/take-a-tour")).toBe(false); expect(writes).toEqual([]);
  });
  it("starts with exactly half present and skips absent targets without inventing a step", async () => {
    fixture.targets = [TOURS.today.steps[0].target, TOURS.today.steps[3].target]; render(ui()); const tour = await opened();
    expect(tour.textContent).toContain("Step 1 of 2"); fireEvent.click(within(tour).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(panel()?.textContent).toContain("Step 2 of 2"));
    expect(within(panel()!).getByRole("heading", { name: TOURS.today.steps[3].title })).toBeTruthy();
    expect(within(panel()!).getByRole("button", { name: "Finish" })).toBeTruthy(); expect(writes).toEqual([]);
  });

  it("leaves an actual open Modal and its focus alone without a progress PUT", async () => {
    fixture.dialog = true; setRoute("/app", "tour=today"); render(ui());
    await screen.findByText("The tour is waiting while a dialog or build check-in is in view.");
    expect(screen.getByRole("dialog", { name: "Existing page controls" })).toBeTruthy(); expect(panel()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep editing" })); expect(scroll).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });

  it("honors every visible marked check-in content variant without focus stealing", async () => {
    const variants = ["request loading", "request error", "fallback error", "confirmed summary", "ineligible row", "collapsed prompt", "expanded panel"];
    fixture.checkin = variants[0]; setRoute("/app", "tour=today"); const view = render(ui());
    const control = screen.getByRole("button", { name: "Check-in control" }); control.focus();
    for (const variant of variants) {
      fixture.checkin = variant; view.rerender(ui()); await screen.findByText("The tour is waiting while a dialog or build check-in is in view.");
      expect(screen.getByTestId("marked-checkin").textContent).toContain(variant); expect(panel()).toBeNull();
      expect(document.activeElement).toBe(control); expect(scroll).not.toHaveBeenCalled(); expect(writes).toEqual([]);
    }
  });

  it("does not admit a held preferences answer into fullscreen or auto-start after fullscreen ends", async () => {
    const held = heldJson({ goals: ["improve"] }); get = async () => held.response;
    render(ui()); const reading = screen.getByTestId("reading-focus"); reading.focus();
    await waitFor(() => expect(held.decoded()).toBe(true)); setFullscreen(document.querySelector('[data-tour-surface]'));
    await act(async () => held.release()); await settled();
    expect(panel()).toBeNull(); expect(document.activeElement).toBe(reading); expect(document.body.style.overflow).not.toBe("hidden");
    setFullscreen(null); await settled(); await settled();
    expect(panel()).toBeNull(); expect(scroll).not.toHaveBeenCalled(); expect(writes).toEqual([]); expect(saved()).toBe(false);
    await act(async () => setRoute("/app", "tour=today"));
    const replay = await opened(); expect(replay.contains(document.activeElement)).toBe(true); expect(writes).toEqual([]);
  });

  it.each(["token", "decoded-body"] as const)("retires a held finish %s across fullscreen entry/exit without a completion or restart", async boundary => {
    const heldToken = deferred<string>(), heldBody = heldJson({ toursDone: { today: TOURS.today.version } });
    render(ui()); await opened(); await toLastStep();
    if (boundary === "token") auth.getToken.mockImplementationOnce(() => heldToken.promise); else put = async () => heldBody.response;
    const tokens = auth.getToken.mock.calls.length;
    fireEvent.click(within(panel()!).getByRole("button", { name: "Finish" }));
    if (boundary === "token") await waitFor(() => expect(auth.getToken).toHaveBeenCalledTimes(tokens + 1));
    else await waitFor(() => expect(heldBody.decoded()).toBe(true));
    // Entry and exit in one turn must retire the attempt even before the observer's next frame.
    setFullscreen(document.querySelector('[data-tour-surface]')); setFullscreen(null);
    await waitFor(() => expect(panel()).toBeNull());
    await settled(); expect(panel()).toBeNull();
    await act(async () => setRoute("/app", "tour=today")); const replay = await opened();
    expect(panel()).toBe(replay); expect(saved()).toBe(false); expect(writes).toHaveLength(boundary === "token" ? 0 : 1);
    if (boundary === "decoded-body") expect(writes[0].signal?.aborted).toBe(true);
    const skip = within(replay).getByRole("button", { name: "Skip tour" });
    expect(skip.getAttribute("aria-disabled")).not.toBe("true");
    expect(within(replay).getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false);
    // A new save can start while the old JWT/body is still held. Keep the new
    // ACK pending while releasing the old operation, which must not finish it.
    const fresh = deferred<Response>(); put = () => fresh.promise;
    fireEvent.click(skip);
    await waitFor(() => expect(writes).toHaveLength(boundary === "token" ? 1 : 2));
    const freshWrite = writes.at(-1)!; expect(freshWrite.signal?.aborted).toBe(false);
    expect(within(replay).getByRole("button", { name: "Saving…" }).getAttribute("aria-disabled")).toBe("true");
    if (boundary === "token") await act(async () => heldToken.resolve("jwt-owner-a")); else await act(async () => heldBody.release());
    await settled(); await settled();
    expect(panel()).toBe(replay); expect(saved()).toBe(false); expect(writes).toHaveLength(boundary === "token" ? 1 : 2);
    expect(freshWrite.signal?.aborted).toBe(false);
    expect(within(replay).getByRole("button", { name: "Saving…" }).getAttribute("aria-disabled")).toBe("true");
    expect(within(replay).getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
    await act(async () => fresh.resolve(reply({ toursDone: { today: TOURS.today.version } })));
    await waitFor(() => expect(panel()).toBeNull()); expect(saved()).toBe(true); expect(writes).toHaveLength(boundary === "token" ? 1 : 2);
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it.each(["target", "dialog"] as const)("retires an interrupted active %s without auto-restarting at step one", async reason => {
    const view = render(ui()); await opened(); fireEvent.click(within(panel()!).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(panel()?.textContent).toContain("Step 2 of 4")); const count = scroll.mock.calls.length;
    if (reason === "target") fixture.targets = fixture.targets.filter(target => target !== TOURS.today.steps[1].target); else fixture.dialog = true;
    view.rerender(ui()); await screen.findByText("The tour paused to leave your page controls available. It has not saved a completion."); expect(panel()).toBeNull();
    if (reason === "target") fixture.targets = TOURS.today.steps.map(step => step.target); else fixture.dialog = false;
    view.rerender(ui()); fireEvent.resize(window); await settled(); await settled();
    expect(panel()).toBeNull(); expect(scroll).toHaveBeenCalledTimes(count); expect(writes).toEqual([]);
  });

  it.each(["owner", "route", "record"] as const)("fences a held completion JWT across %s ABA before any PUT and permits a fresh completion", async boundary => {
    gameSurface(); const held = deferred<string>(); const view = render(ui()); await opened();
    const tokens = auth.getToken.mock.calls.length; auth.getToken.mockImplementationOnce(() => held.promise);
    fireEvent.click(within(panel()!).getByRole("button", { name: "Skip tour" })); await waitFor(() => expect(auth.getToken).toHaveBeenCalledTimes(tokens + 1));
    await aba(view, boundary); await act(async () => held.resolve("jwt-owner-a")); expect(writes).toEqual([]); expect(saved()).toBe(false);
    fireEvent.click(within(await opened()).getByRole("button", { name: "Skip tour" }));
    await waitFor(() => expect(panel()).toBeNull()); expect(writes).toHaveLength(1); expect(saved()).toBe(true);
  });

  it.each(["owner", "route", "record"] as const)("fences a decoded completion body across %s ABA without patching the new owner cache", async boundary => {
    gameSurface(); const held = heldJson({ toursDone: { game: TOURS.game.version } }); put = async () => held.response;
    const view = render(ui()); fireEvent.click(within(await opened()).getByRole("button", { name: "Skip tour" })); await waitFor(() => expect(held.decoded()).toBe(true));
    await aba(view, boundary); await waitFor(() => expect(writes[0].signal?.aborted).toBe(true)); await act(async () => held.release());
    expect(saved()).toBe(false); expect(panel()).not.toBeNull(); expect(writes).toHaveLength(1);
    put = async () => reply({ toursDone: { game: TOURS.game.version } }); fireEvent.click(within(panel()!).getByRole("button", { name: "Skip tour" }));
    await waitFor(() => expect(panel()).toBeNull()); expect(writes).toHaveLength(2); expect(saved()).toBe(true);
  });

  it.each(["readyfalse", "previous-parent-answer", "unmount"] as const)("cancels a held decoded write after %s removes admission", async boundary => {
    const held = heldJson({ toursDone: { today: TOURS.today.version } }); put = async () => held.response;
    const view = render(ui()); fireEvent.click(within(await opened()).getByRole("button", { name: "Skip tour" })); await waitFor(() => expect(held.decoded()).toBe(true));
    if (boundary === "unmount") view.unmount(); else { if (boundary === "readyfalse") fixture.ready = false; else fixture.previous = true; view.rerender(ui()); }
    await waitFor(() => expect(writes[0].signal?.aborted).toBe(true)); await act(async () => held.release());
    expect(panel()).toBeNull(); expect(saved()).toBe(false); expect(writes).toHaveLength(1);
  });
});
