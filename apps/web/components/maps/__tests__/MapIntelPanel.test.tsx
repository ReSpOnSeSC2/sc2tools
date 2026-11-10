import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { MapIntelResponse } from "@/lib/mapIntel";

const state = vi.hoisted(() => ({ paths: [] as string[], respond: (_path: string): unknown => undefined }));
vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null) => {
    if (path) state.paths.push(path);
    return { data: path ? state.respond(path) : undefined, error: undefined, isPreviousData: false, mutate: vi.fn() };
  },
}));
vi.mock("@/components/help/LazyHelpLink", () => ({
  LazyHelpLink: ({ slug, anchor, children }: { slug: string; anchor?: string; children: React.ReactNode }) => <a href={`/help/${slug}${anchor ? `#${anchor}` : ""}`}>{children}</a>,
}));

import { MapIntelPanel } from "../MapIntelPanel";
import { DossierMapIntel } from "@/components/analyzer/opponents/DossierMapIntel";

const BOUNDS = { minX: 0, minY: 0, maxX: 200, maxY: 200 };
const answer = (overrides: Partial<MapIntelResponse> = {}): MapIntelResponse => ({
  ok: true, kind: "opp_proxy", map: "Goldenaura", grid: 48, bounds: BOUNDS, points: 9, games: 6, scanned: 30, capped: false,
  maxGames: 300, minGames: 3, belowMinimum: false,
  cells: [{ x: 14, y: 7, value: 6, intensity: 1, games: 5 }],
  zones: [
    { x: 60, y: 30, share: 0.62, games: 5, base: "natural", area: "bottom left" },
    { x: 100, y: 100, share: 0.2, games: 1, base: null, area: "centre" },
  ],
  ...overrides,
});
const params = (path: string) => new URL(path.replace(/#.*$/, ""), "https://example.test");

// jsdom has no 2D canvas; the panel skips drawing when there is no context.
beforeAll(() => { vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null); });
afterEach(() => { cleanup(); state.paths = []; });

describe("MapIntelPanel", () => {
  it("shows the sample, a worded legend and the hot zones as numbered text", () => {
    state.respond = () => answer();
    render(<MapIntelPanel map="Goldenaura" aliases={["Goldenaura LE"]} filterQuery="?race=P" dbRev={4} matchupControl />);
    const first = params(state.paths[0]);
    expect(first.pathname).toBe("/v1/spatial/opponent-proxies");
    expect(Object.fromEntries(first.searchParams)).toEqual({ race: "P", map: "Goldenaura", map_exact: '["Goldenaura","Goldenaura LE"]', grid: "48" });
    expect(state.paths[0].endsWith("#4")).toBe(true);
    expect(screen.getByText("Proxies in 6 of 30 analysed games")).toBeTruthy();
    expect(screen.getByRole("img", { name: /Their proxies on Goldenaura\. Proxies in 6 of 30 analysed games/ })).toBeTruthy();
    expect(screen.getByText("fewer")).toBeTruthy();
    expect(screen.getByText("more")).toBeTruthy();
    const zones = within(screen.getByRole("list", { name: /Top 2 hot zones/ })).getAllByRole("listitem");
    expect(zones.map((zone) => zone.textContent)).toEqual(["1Natural, bottom left62% · seen in 5 games", "2Centre of the map20% · seen in 1 game"]);
  });

  it("switches layer and opponent race from keyboard-reachable radio groups", () => {
    state.respond = () => answer({ kind: "battle" });
    render(<MapIntelPanel map="Goldenaura" matchupControl />);
    fireEvent.click(screen.getByRole("radio", { name: "Fights" }));
    expect(params(state.paths.at(-1)!).pathname).toBe("/v1/spatial/battle");
    fireEvent.click(screen.getByRole("radio", { name: "Versus Zerg" }));
    expect(params(state.paths.at(-1)!).searchParams.get("opp_race")).toBe("Z");
    fireEvent.change(screen.getByLabelText(/Heat opacity/), { target: { value: "40" } });
    expect(screen.getByText("40%")).toBeTruthy();
  });

  it("withholds the heat below the minimum sample and says how many games there are", () => {
    state.respond = () => answer({ games: 2, belowMinimum: true });
    render(<MapIntelPanel map="Goldenaura" />);
    expect(screen.getByRole("status").textContent).toBe("Not enough games to show a pattern yet: proxies in 2 games, 3 needed.");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("explains an empty map and links the help article", () => {
    state.respond = () => answer({ scanned: 0, games: 0, bounds: null, cells: [], zones: [] });
    render(<MapIntelPanel map="New Map" />);
    expect(screen.getByText("No spatial data for this map yet — re-analyze in the desktop app")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Why a map is empty" }).getAttribute("href")).toBe("/help/map-intel#empty-maps");
  });
});

describe("DossierMapIntel", () => {
  it("asks for one opponent's games only once it is expanded", async () => {
    state.respond = () => answer({ minGames: 1 });
    render(<DossierMapIntel map="Goldenaura" pulseId="p-1" mergeLinked filterQuery="?mergeLinked=1&since=2026-01-01" dbRev={2} />);
    expect(state.paths).toEqual([]);
    const toggle = screen.getByRole("button", { name: "Where they proxy / fight on this map" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByRole("radio", { name: "Their proxies" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Your buildings" })).toBeNull();
    const query = params(state.paths[0]).searchParams;
    expect([query.get("opponent"), query.get("mergeLinked"), query.get("since")]).toEqual(["p-1", "1", "2026-01-01"]);
  });
});
