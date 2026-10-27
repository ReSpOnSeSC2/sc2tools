import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_BASE } from "@/lib/clientApi";
import { COMMAND_SEARCH_RECENT_KEY } from "@/lib/commandSearchRecent";
import { SettingsShell, type SettingsTabId } from "@/components/analyzer/settings/SettingsShell";
import { usePublishDirty } from "@/components/analyzer/settings/SettingsContext";
import { CommandSearchProvider } from "../CommandSearchProvider";
import { useCommandChrome, useCommandSearch, type CommandOpening } from "../CommandSearchContext";

const h = vi.hoisted(() => ({
  path: "/app", search: "", listeners: new Set<() => void>(), push: vi.fn(),
  auth: { userId: "A" as string | null, isLoaded: true, isSignedIn: true, getToken: vi.fn<() => Promise<string | null>>() },
  open: null as ((options?: CommandOpening) => void) | null,
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.auth }));
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react"), router = { push: h.push };
  return { usePathname: () => h.path, useRouter: () => router, useSearchParams: () => {
    const query = useSyncExternalStore(callback => { h.listeners.add(callback); return () => { h.listeners.delete(callback); }; },
      () => h.search, () => h.search);
    return new URLSearchParams(query);
  } };
});
// Only unrelated public guide availability is disabled at its existing flag
// boundary. Provider/Runtime/Palette/Modal/Settings/hook/ownerScope/stream reader
// and DTO parsing are all real; no new selection/admission callbacks are mocked.
vi.mock("@/lib/guides/flags", () => ({ guidesEnabled: () => false }));

const ENDPOINT = `${API_BASE.replace(/\/+$/, "")}/v1/search/quick`;
const fetching = vi.fn<typeof fetch>();
const navigation = [
  { key: "today", href: "/app", label: "Today" }, { key: "opponents", href: "/app/opponents", label: "Opponents" },
  { key: "builds-library", href: "/builds", label: "Build library" }, { key: "maps", href: "/app/maps", label: "Maps" },
  { key: "settings", href: "/settings", label: "Settings" },
];
function payload() {
  return { version: 2, groups: {
    opponents: { status: "ready", hasMore: false, items: [
      { pulseId: "owner/pulse", displayNameSample: "Literal own opponent", race: null, lastSeen: null },
    ] },
    customBuilds: { status: "ready", hasMore: false, items: [
      { slug: "owner build", name: "Literal own build", race: "Protoss", vsRace: null, perspective: null, updatedAt: null },
    ] },
    maps: { status: "ready", hasMore: false, items: [{ map: "Literal own map LE" }] },
  } };
}
function response(value: unknown = payload()) {
  const result = new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  Object.defineProperty(result, "url", { value: ENDPOINT }); return result;
}
function Draft({ id }: { id: SettingsTabId }) {
  const [value, setValue] = useState("saved"); usePublishDirty(id, value !== "saved");
  return <input aria-label={`${id} draft`} value={value} onChange={event => setValue(event.target.value)} />;
}
function Host({ settings = false }: { settings?: boolean }) {
  const context = useCommandSearch()!;
  const chrome = useMemo(() => ({ ownerKey: context.ownerKey, navigation }), [context.ownerKey]);
  useCommandChrome(chrome); useLayoutEffect(() => { h.open = context.open; }, [context.open]);
  return <><button type="button" onClick={() => context.open({ query: "Literal own" })}>Open real search</button>
    {settings ? <SettingsShell ownerKey={context.ownerKey} initialTab="profile" renderTab={id => <Draft id={id} />} /> : null}</>;
}
function tree(settings = false) { return <CommandSearchProvider><Host settings={settings} /></CommandSearchProvider>; }
async function open(options: CommandOpening = { query: "Literal own" }) {
  act(() => h.open!(options));
  return screen.findByRole("combobox", { name: options.scope === "guides" ? "Find a guide" : "Search" });
}
async function ready() { return screen.findByRole("option", { name: "Literal own opponent" }); }
function queryEntry(query: string) {
  window.history.replaceState(null, "", `${h.path}${query}`); h.search = query; h.listeners.forEach(listener => listener());
}
beforeEach(() => {
  h.path = "/app"; h.search = ""; h.push.mockReset(); h.open = null;
  h.auth.userId = "A"; h.auth.isLoaded = true; h.auth.isSignedIn = true;
  h.auth.getToken.mockReset().mockResolvedValue("A-token");
  window.history.replaceState(null, "", "/app"); localStorage.clear();
  fetching.mockReset().mockImplementation(async () => response()); vi.stubGlobal("fetch", fetching);
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("real lazy private search consumer and guarded navigation", () => {
  it("does nothing closed, then sends only literal body q while keeping IDs/query out of static recents", async () => {
    render(tree()); expect(fetching).not.toHaveBeenCalled(); expect(h.auth.getToken).not.toHaveBeenCalled();
    const input = await open({ query: "É  [a].*" }); await ready();
    expect((input as HTMLInputElement).value).toBe("É  [a].*"); expect(fetching).toHaveBeenCalledOnce();
    expect(fetching.mock.calls[0][0]).toBe(ENDPOINT);
    expect(fetching.mock.calls[0][1]?.body).toBe(JSON.stringify({ q: "É  [a].*" }));
    expect(window.location.search).toBe("");
    expect(localStorage.getItem(COMMAND_SEARCH_RECENT_KEY)).not.toMatch(/owner\/pulse|owner build|Literal|É/);
  });
  it.each([
    ["Literal own opponent", "/app/opponents/owner%2Fpulse"],
    ["Literal own build", "/builds/owner%20build"],
    ["Literal own map LE", "/app/maps?focus=Literal%20own%20map%20LE"],
  ])("transfers %s before real Modal unmount and navigates exactly once", async (label, href) => {
    render(tree()); await open(); await ready();
    const row = screen.getByRole("option", { name: label }); fireEvent.click(row); fireEvent.click(row);
    await waitFor(() => expect(h.push).toHaveBeenCalledOnce()); expect(h.push).toHaveBeenCalledWith(href);
    expect(screen.queryByRole("combobox", { name: "Search" })).toBeNull();
  });
  it.each(["guides", "signed-out", "loading"])("does not authenticate or POST private search in %s scope", async mode => {
    if (mode === "signed-out") h.auth.isSignedIn = false;
    if (mode === "loading") h.auth.isLoaded = false;
    render(tree()); await open({ query: "Literal own", scope: mode === "guides" ? "guides" : "all" });
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(fetching).not.toHaveBeenCalled(); expect(h.auth.getToken).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Your opponents" })).toBeNull();
  });
  it("keeps an unavailable map category separate and opens its full library through the provider", async () => {
    const data = payload();
    fetching.mockImplementation(async () => response({ ...data, groups: { ...data.groups,
      maps: { status: "unavailable", items: [], hasMore: null, reason: "source_budget_exceeded" } } }));
    render(tree()); await open(); await ready();
    expect(screen.getByText("This library is too large for quick search.")).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "Open Maps" }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/app/maps"));
  });
  it("uses the actual Settings dirty guard for Stay then a fresh private Discard", async () => {
    h.path = "/settings"; window.history.replaceState(null, "", "/settings"); render(tree(true));
    const input = screen.getByRole("textbox", { name: "profile draft" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "keep this draft" } }); const before = window.location.href;
    await open(); fireEvent.click(await ready());
    await screen.findByRole("dialog", { name: "Discard unsaved changes?" }); expect(h.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stay on this tab" }));
    expect(input.value).toBe("keep this draft"); expect(window.location.href).toBe(before);
    await open(); fireEvent.click(await ready());
    await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    fireEvent.click(screen.getByRole("button", { name: "Discard & switch" }));
    expect(h.push).toHaveBeenCalledOnce(); expect(h.push).toHaveBeenCalledWith("/app/opponents/owner%2Fpulse");
  });
  it("rejects an actual pending Settings selection after a newer real opening", async () => {
    h.path = "/settings"; window.history.replaceState(null, "", "/settings"); render(tree(true));
    const input = screen.getByRole("textbox", { name: "profile draft" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "retain unsaved" } }); const before = window.location.href;
    await open(); fireEvent.click(await ready());
    const discard = await screen.findByRole("button", { name: "Discard & switch" });
    await open({ query: "New intent" }); fireEvent.click(discard);
    expect(h.push).not.toHaveBeenCalled(); expect(input.value).toBe("retain unsaved"); expect(window.location.href).toBe(before);
    expect((screen.getByRole("combobox", { name: "Search" }) as HTMLInputElement).value).toBe("New intent");
  });
  it("retires a held real request through committed same-path query A→B→A", async () => {
    let release!: (value: Response) => void;
    fetching.mockReturnValueOnce(new Promise<Response>(resolve => { release = resolve; }));
    render(tree()); await open(); await waitFor(() => expect(fetching).toHaveBeenCalledOnce());
    const signal = fetching.mock.calls[0][1]?.signal;
    act(() => queryEntry("?view=B")); act(() => queryEntry(""));
    expect(screen.queryByRole("combobox", { name: "Search" })).toBeNull();
    await act(async () => release(response()));
    expect(signal?.aborted).toBe(true); expect(h.push).not.toHaveBeenCalled(); expect(screen.queryByText("Literal own opponent")).toBeNull();
  });
});
