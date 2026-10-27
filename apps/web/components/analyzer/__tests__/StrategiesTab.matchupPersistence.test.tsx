import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AnalyzerProvider } from "@/components/AnalyzerProvider";
import { useFilters, type AnalyzerFilters } from "@/lib/filterContext";
import { BuildVsStrategyView } from "../StrategiesTabBuildVs";

const h = vi.hoisted(() => ({
  userId: "owner-a" as string | null, isLoaded: true, isSignedIn: true,
  path: "/app/strategies", search: "", replace: vi.fn(),
  paths: [] as Array<{ owner: string | null; path: string | null }>,
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h }));
vi.mock("next/navigation", () => ({ usePathname: () => h.path,
  useSearchParams: () => new URLSearchParams(h.search), useRouter: () => ({ replace: h.replace }) }));
vi.mock("@/lib/useSeasons", async original => ({ ...await original<typeof import("@/lib/useSeasons")>(), useSeasons: () => ({ data: undefined }) }));
vi.mock("@/lib/useUserSocket", () => ({ useUserSocket: () => undefined }));
vi.mock("@/components/analyzer/arcade/hooks/useAnalysisGames", () => ({
  AnalysisGamesProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string | null) => {
  h.paths.push({ owner: h.userId, path });
  return { data: path ? [{ my_build: "Robo", opp_strat: "Macro", total: 20, wins: 10,
    losses: 10, winRate: .5, myMatchups: { P: 2, T: 1, Z: 17 } }] : undefined,
  isLoading: false, isPreviousData: false, error: undefined };
} }));

const key = (owner = "owner-a") => `analyzer.strategies.matrixRace:${owner}`;
const filters = (): AnalyzerFilters => JSON.parse(screen.getByTestId("shared-filters").textContent ?? "{}");
const preference = (owner = "owner-a") => localStorage.getItem(key(owner));
const radio = (name: string) => within(screen.getByRole("radiogroup", { name: "Matrix matchup" }))
  .getByRole("radio", { name });
const expectSelected = (name: string) => expect(radio(name).getAttribute("aria-checked")).toBe("true");

function RouteHost() {
  const { filters, setFilters } = useFilters();
  return <><pre data-testid="shared-filters">{JSON.stringify(filters)}</pre>
    <button onClick={() => setFilters({ ...filters, map: "New map" })}>Change map</button>
    <button onClick={() => setFilters({ ...filters, opp_race: undefined })}>Clear global opponent race</button>
    {h.path === "/app/strategies" ? <BuildVsStrategyView onOpenBvs={vi.fn()}
      initialView="table" initialMinGames={1} onViewChange={vi.fn()}
      onMinGamesChange={vi.fn()} renderMinGamesPicker={() => null} /> : <p>Another analyzer page</p>}
  </>;
}
function tree(syncUrl = false) { return <AnalyzerProvider syncUrl={syncUrl}><RouteHost /></AnalyzerProvider>; }
type View = ReturnType<typeof render>;
async function navigate(view: View, href: string) {
  const next = new URL(href, window.location.href);
  await act(async () => {
    h.path = next.pathname; h.search = next.searchParams.toString();
    window.history.replaceState({}, "", `${h.path}${next.search}`); view.rerender(tree());
  });
}

beforeEach(() => {
  localStorage.clear(); Object.assign(h, { userId: "owner-a", isLoaded: true, isSignedIn: true,
    path: "/app/strategies", search: "", paths: [] }); h.replace.mockReset();
  localStorage.setItem("analyzer.filters", JSON.stringify({ preset: "current_season", race: "P",
    regions: "EU", map_pool: "all", game_size: "1v1", exclude_too_short: false, regions_rev: 1 }));
  window.history.replaceState({}, "", h.path);
});
afterEach(cleanup);

it.each([["versus Terran", "T"], ["All", "all"]])(
  "keeps %s after leaving Strategies, changing cohorts, returning and reloading", async (name, value) => {
    const view = render(tree()); expectSelected("versus Zerg");
    const shared = filters(), stored = localStorage.getItem("analyzer.filters");
    fireEvent.click(radio(name)); expect(preference()).toBe(JSON.stringify(value));
    expect(filters()).toEqual(shared); expect(localStorage.getItem("analyzer.filters")).toBe(stored);
    await navigate(view, "/app/trends"); expect(screen.queryByRole("radiogroup", { name: "Matrix matchup" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change map" }));
    await navigate(view, "/app/strategies"); expectSelected(name);
    expect(filters()).toMatchObject({ preset: "current_season", map: "New map", regions: "EU", race: "P" });
    expect(filters().opp_race).toBeUndefined();
    view.unmount(); render(tree()); await waitFor(() => expectSelected(name));
    // Map drills reset on reload; the matchup preference and global controls persist.
    expect(filters()).toMatchObject({ preset: "current_season", regions: "EU", race: "P",
      map_pool: "all", game_size: "1v1", exclude_too_short: false });
    expect(filters()).not.toHaveProperty("map");
    expect(preference()).toBe(JSON.stringify(value));
  },
);

it("keeps the explicit choice when the current cohort changes without remounting", () => {
  render(tree()); fireEvent.click(radio("versus Terran"));
  fireEvent.click(screen.getByRole("button", { name: "Change map" })); expectSelected("versus Terran");
  expect(h.paths.at(-1)?.path).toContain("opp_race=T"); expect(h.paths.at(-1)?.path).toContain("map=New+map");
  expect(filters().preset).toBe("current_season");
});

it("restores each owner's choice without rendering another owner's selection during auth changes", () => {
  const view = render(tree()); fireEvent.click(radio("versus Terran"));
  h.paths = []; h.userId = "owner-b"; view.rerender(tree()); expectSelected("versus Zerg");
  const ownerBRequests = h.paths.filter(row => row.owner === "owner-b");
  expect(ownerBRequests.length).toBeGreaterThan(0);
  expect(ownerBRequests.every(row => !row.path?.includes("opp_race=T"))).toBe(true);
  fireEvent.click(radio("versus Protoss")); expect(preference("owner-b")).toBe('"P"');
  h.userId = "owner-a"; view.rerender(tree()); expectSelected("versus Terran");
  h.userId = "owner-b"; view.rerender(tree()); expectSelected("versus Protoss");
  h.isLoaded = false; view.rerender(tree()); expectSelected("versus Zerg");
  fireEvent.click(radio("versus Terran")); expectSelected("versus Zerg");
  expect(preference("owner-a")).toBe('"T"'); expect(preference("owner-b")).toBe('"P"');
  expect(localStorage.getItem("analyzer.strategies.matrixRace:unavailable")).toBeNull();
});

it("does not use or change an unowned preference while signed out", () => {
  const unowned = "analyzer.strategies.matrixRace:unavailable";
  localStorage.setItem(unowned, '"T"'); localStorage.setItem(key(), '"P"');
  Object.assign(h, { userId: null, isSignedIn: false });
  const view = render(tree()); expectSelected("versus Zerg");
  fireEvent.click(radio("versus Terran")); expectSelected("versus Zerg");
  expect(localStorage.getItem(unowned)).toBe('"T"'); expect(preference()).toBe('"P"');
  Object.assign(h, { userId: "owner-a", isSignedIn: true }); view.rerender(tree());
  expectSelected("versus Protoss");
});

it.each(['{"race":"T"}', '"R"', '"terran"', "{bad-json"])(
  "ignores invalid saved matrix state %s and saves the next explicit valid choice", raw => {
    localStorage.setItem(key(), raw); render(tree()); expectSelected("versus Zerg");
    expect(preference()).toBe(raw); fireEvent.click(radio("versus Protoss"));
    expectSelected("versus Protoss"); expect(preference()).toBe('"P"');
  },
);

it("honors an explicit shared URL without overwriting its cohort or the owner's matrix preference", async () => {
  localStorage.setItem(key(), '"T"'); const stored = localStorage.getItem("analyzer.filters");
  h.search = "filters=1&preset=custom&since=2026-06-01T00%3A00%3A00.000Z&until=2026-07-01T00%3A00%3A00.000Z&race=P&opp_race=P&regions=EU&map=Shared+map";
  window.history.replaceState({}, "", `${h.path}?${h.search}`);
  const view = render(tree(true));
  await waitFor(() => expect(filters()).toMatchObject({ preset: "custom", opp_race: "P", map: "Shared map",
    since: "2026-06-01T00:00:00.000Z", until: "2026-07-01T00:00:00.000Z" }));
  expect(screen.queryByRole("radiogroup", { name: "Matrix matchup" })).toBeNull();
  expect(h.paths.at(-2)?.path).toContain("opp_race=P"); expect(preference()).toBe('"T"');
  expect(localStorage.getItem("analyzer.filters")).toBe(stored);
  fireEvent.click(screen.getByRole("button", { name: "Clear global opponent race" })); expectSelected("versus Terran");
  expect(filters()).toMatchObject({ preset: "custom", map: "Shared map", regions: "EU" });
  view.unmount(); h.search = ""; window.history.replaceState({}, "", h.path); render(tree());
  await waitFor(() => expectSelected("versus Terran"));
  expect(filters()).toMatchObject({ preset: "current_season", regions: "EU", race: "P",
    map_pool: "all", game_size: "1v1", exclude_too_short: false });
  expect(filters()).not.toHaveProperty("map");
});
