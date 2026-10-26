import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { FiltersContext, type AnalyzerFilters } from "@/lib/filterContext";
import { TrendsDataProvider } from "@/lib/trendsDataContext";
import { TrendsTab } from "../TrendsTab";
import { TRENDS_FIXTURE_FILTERS, trendsFixturePayload } from "../../../tests/e2e/trends-demand-fixture-data.mjs";

const auth = vi.hoisted(() => ({ owner: "owner-a", listeners: new Set<() => void>() }));
vi.mock("@clerk/nextjs", async () => {
  const { useMemo, useSyncExternalStore } = await import("react");
  return { useAuth: () => {
    const userId = useSyncExternalStore((listener) => { auth.listeners.add(listener); return () => auth.listeners.delete(listener); }, () => auth.owner);
    const getToken = useMemo(() => async () => `synthetic-${userId}`, [userId]);
    return { userId, isLoaded: true, isSignedIn: true, getToken };
  } };
});
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: ReactNode }) => <a {...props}>{children}</a> }));
// Chart components and hooks stay real; browser proof owns native Recharts sizing.
vi.mock("recharts", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Empty = () => null;
  return { ResponsiveContainer: Box, ComposedChart: Box, BarChart: Box, LineChart: Box, AreaChart: Box,
    Area: Empty, Line: Empty, Bar: Empty, Cell: Empty, ReferenceLine: Empty, ReferenceDot: Empty,
    XAxis: Empty, YAxis: Empty, Tooltip: Empty, CartesianGrid: Empty, Legend: Empty };
});

type Read = { owner: string; path: string; search: string };
const reads: Read[] = [];
const observers: Array<{ target?: Element; callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }> = [];
const frames: FrameRequestCallback[] = [];
const positions: Record<string, number> = {};
let holdBody: ((row: Read) => Promise<unknown> | null) | undefined;
const originalScrollIntoView = Element.prototype.scrollIntoView;

function Fixture({ mode = "personal" }: { mode?: "personal" | "global" }) {
  const [filters, setFilters] = useState<AnalyzerFilters>({ ...TRENDS_FIXTURE_FILTERS, map_pool: "ladder", game_size: "1v1" });
  return <SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false, dedupingInterval: 60_000 }}>
    <FiltersContext.Provider value={{ filters, setFilters, dbRev: 3, bumpRev() {}, seasons: [] }}>
      <TrendsDataProvider mode={mode} cohort={{ excluded_players: ["synthetic-excluded"] }}>
        <label>Unrelated draft<input defaultValue="keep focus" /></label>
        <button onClick={() => setFilters((current) => ({ ...current, map: "Changed map" }))}>Change fixture filters</button>
        <TrendsTab />
      </TrendsDataProvider>
    </FiltersContext.Provider>
  </SWRConfig>;
}

function notify(label: string, near: boolean) {
  const row = observers.find((entry) => entry.target?.getAttribute("data-deferred-chart") === label);
  if (!row) throw new Error(`No observer for ${label}`);
  act(() => row.callback([{ isIntersecting: near, target: row.target } as IntersectionObserverEntry], {} as IntersectionObserver));
}
function flushFrames() { act(() => { frames.splice(0).forEach((callback) => callback(0)); }); }
function navigate(label: string) { fireEvent.click(within(screen.getByRole("navigation", { name: "Trend sections" })).getByRole("button", { name: label })); }
function changeOwner(owner: string) { act(() => { auth.owner = owner; [...auth.listeners].forEach((listener) => listener()); }); }
const byPath = (path: string) => reads.filter((row) => row.path === path);

beforeEach(() => {
  auth.owner = "owner-a";
  reads.length = 0; observers.length = 0; frames.length = 0; holdBody = undefined;
  Object.assign(positions, { overview: 0, performance: 1000, time: 2000, explorer: 3000, fingerprint: 4000 });
  vi.stubGlobal("ResizeObserver", undefined);
  vi.stubGlobal("IntersectionObserver", class {
    row: typeof observers[number];
    constructor(callback: IntersectionObserverCallback) { this.row = { callback, disconnect: vi.fn() }; observers.push(this.row); }
    observe(target: Element) { this.row.target = target; }
    disconnect() { this.row.disconnect(); }
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.push(callback); return frames.length; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const match = /^trends-(.+)-heading$/.exec(this.id);
    const top = match ? positions[match[1].replace("-section", "")] : 0;
    return { top, bottom: match ? top + 40 : this.classList.contains("sticky") ? 80 : 10000, left: 0, right: 1280, width: 1280, height: 40, x: 0, y: top, toJSON() {} };
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const owner = String(new Headers(init?.headers).get("authorization")).replace("Bearer synthetic-", "");
    const row = { owner, path: url.pathname, search: url.search }; reads.push(row);
    const response = new Response(JSON.stringify(trendsFixturePayload(row.path, row.search, owner)), { headers: { "content-type": "application/json" } });
    const held = holdBody?.(row);
    if (held) Object.defineProperty(response, "json", { value: () => held });
    return response;
  }));
});
afterEach(() => {
  cleanup(); window.localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalScrollIntoView) Element.prototype.scrollIntoView = originalScrollIntoView;
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

describe("Trends demand integration with actual charts and request hooks", () => {
  it("requests only the immediate row until admission and activates with the newest filters", async () => {
    render(<Fixture />);
    await waitFor(() => expect(reads.length).toBe(2));
    expect(reads.map((row) => row.path)).toEqual(["/v1/timeseries", "/v1/timeseries"]);
    expect(new Set(reads.map((row) => new URLSearchParams(row.search).get("interval")))).toEqual(new Set(["day", "week"]));
    fireEvent.click(screen.getByRole("button", { name: "Change fixture filters" }));
    await waitFor(() => expect(reads.length).toBe(4));
    expect(byPath("/v1/momentum")).toHaveLength(0);
    notify("Session patterns", true);
    await waitFor(() => expect(byPath("/v1/momentum")).toHaveLength(1));
    expect(new URLSearchParams(byPath("/v1/momentum")[0].search).get("map")).toBe("Changed map");
    expect(byPath("/v1/length-buckets")).toHaveLength(0);
  });

  it("uses one shared matchup GET and preserves the actual Inspect window while scrolling", async () => {
    render(<Fixture />);
    notify("Matchup trends", true);
    const inspect = await screen.findByRole("combobox", { name: "PvZ rating window" });
    fireEvent.change(inspect, { target: { value: "7" } });
    notify("Matchup trends", false);
    notify("Matchup trends", true);
    expect(screen.getByRole("combobox", { name: "PvZ rating window" })).toBe(inspect);
    expect((inspect as HTMLSelectElement).value).toBe("7");
    expect(byPath("/v1/timeseries/matchups")).toHaveLength(1);
    expect(screen.getByText("16-game estimate")).toBeTruthy();
  });

  it("keeps passive navigation free of focus, scroll, URL, filter and activation effects", async () => {
    render(<Fixture />);
    await waitFor(() => expect(reads.length).toBe(2));
    flushFrames();
    const input = screen.getByRole("textbox", { name: "Unrelated draft" }); input.focus();
    const href = location.href;
    const calls = vi.mocked(Element.prototype.scrollIntoView).mock.calls.length;
    positions.overview = -1000; positions.performance = 0;
    fireEvent.scroll(window); fireEvent.resize(window); flushFrames();
    expect(within(screen.getByRole("navigation")).getByRole("button", { name: "Performance & MMR" }).getAttribute("aria-current")).toBe("location");
    expect(document.activeElement).toBe(input);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(calls);
    expect(location.href).toBe(href);
    expect(reads).toHaveLength(2);
    expect(byPath("/v1/timeseries/mmr")).toHaveLength(0);
  });

  it("honours collapsed state, then explicitly opens and focuses the chosen group", async () => {
    window.localStorage.setItem("analyzer.trends.collapsed", JSON.stringify({ performance: true }));
    render(<Fixture />);
    // SSR and the first client render share the expanded fallback. Restoring
    // the saved collapse retires those initial observers without loading data.
    const retired = observers.filter((row) => row.target?.getAttribute("data-deferred-chart") === "MMR progression");
    expect(retired.length).toBeGreaterThan(0);
    expect(retired.filter((row) => row.target?.isConnected && row.disconnect.mock.calls.length === 0)).toHaveLength(0);
    for (const row of retired) {
      expect(row.disconnect).toHaveBeenCalled();
      expect(row.target?.isConnected).toBe(false);
    }
    expect(byPath("/v1/timeseries/mmr")).toHaveLength(0);
    await act(async () => {
      for (const row of retired) row.callback([{ isIntersecting: true, target: row.target } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(byPath("/v1/timeseries/mmr")).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "MMR progression" })).toBeNull();
    vi.stubGlobal("matchMedia", (media: string): MediaQueryList => ({
      media,
      matches: media === "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    }));
    navigate("Performance & MMR");
    await waitFor(() => expect(byPath("/v1/timeseries/mmr")).toHaveLength(1));
    const heading = screen.getByRole("heading", { name: "Performance & MMR" });
    expect(document.activeElement).toBe(heading);
    expect(Element.prototype.scrollIntoView).toHaveBeenLastCalledWith({ behavior: "auto", block: "start" });
    expect(byPath("/v1/length-buckets")).toHaveLength(0);
    fireEvent.click(within(heading).getByRole("button"));
    expect(screen.queryByRole("heading", { name: "MMR progression" })).toBeNull();
  });

  it.each(["constructor", "observe"])("keeps resize navigation usable after ResizeObserver %s fails", (stage) => {
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor() { if (stage === "constructor") throw new Error("Synthetic unavailable observer"); }
      observe() { throw new Error("Synthetic unavailable observation"); }
      disconnect = disconnect;
    });
    const view = render(<Fixture />);
    const input = screen.getByRole("textbox", { name: "Unrelated draft" }); input.focus();
    positions.overview = -1000; positions.performance = 0;
    fireEvent.resize(window); flushFrames();
    expect(within(screen.getByRole("navigation")).getByRole("button", { name: "Performance & MMR" }).getAttribute("aria-current")).toBe("location");
    expect(document.activeElement).toBe(input);
    view.unmount();
    if (stage === "observe") expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it("keeps the global cohort on real endpoints and excludes Fingerprint", async () => {
    render(<Fixture mode="global" />);
    navigate("Performance & MMR");
    await waitFor(() => expect(byPath("/v1/admin/global-trends/momentum")).toHaveLength(1));
    for (const row of reads) {
      expect(row.path.startsWith("/v1/admin/global-trends/")).toBe(true);
      expect(new URLSearchParams(row.search).get("excluded_players")).toBe("synthetic-excluded");
    }
    expect(screen.queryByRole("button", { name: "Fingerprint" })).toBeNull();
    expect(byPath("/v1/me/fingerprint")).toHaveLength(0);
  });

  it("does not publish a held response body across owner A→B→A", async () => {
    let release: (value: unknown) => void = () => {};
    let heldOnce = false;
    holdBody = (row) => {
      if (heldOnce || row.owner !== "owner-a" || row.path !== "/v1/timeseries" || new URLSearchParams(row.search).get("interval") !== "week") return null;
      heldOnce = true;
      return new Promise((resolve) => { release = resolve; });
    };
    render(<Fixture />);
    await waitFor(() => expect(heldOnce).toBe(true));
    changeOwner("owner-b");
    await waitFor(() => expect(reads.some((row) => row.owner === "owner-b")).toBe(true));
    changeOwner("owner-a");
    await act(async () => release({ interval: "week", points: [{ bucket: "2026-10-01", wins: 1234, losses: 0, total: 1234, winRate: 1 }] }));
    expect(screen.queryByText("1,234")).toBeNull();
    expect(reads.filter((row) => row.owner === "owner-b")).toHaveLength(2);
    expect(reads.filter((row) => row.owner === "owner-a").length).toBeGreaterThanOrEqual(2);
  });
});
