import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AdminGlobalTrendsPage from "./page";
import { useFilters } from "@/lib/filterContext";
import { useTrendsApi, useTrendsDataScope } from "@/lib/trendsDataContext";
import { ALL_PLAYERS, DEFAULT_TREND_VIEW, populationQuery, readTrendView, selectPlayers, trendViewQuery, type TrendViewPreferences } from "./globalTrendsState";

const api = vi.hoisted(() => ({ useApi: vi.fn(), mutate: vi.fn(), request: vi.fn() }));
const navigation = vi.hoisted(() => ({ replace: vi.fn(), search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/global-trends",
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ replace: navigation.replace }),
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "admin-test" }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: (...args: unknown[]) => api.useApi(...args) }));
vi.mock("@/lib/useSeasons", () => ({ useSeasons: () => ({ data: { items: [] } }), rollUpSeasons: () => [] }));
vi.mock("@/components/analyzer/TrendsTab", () => ({ TrendsTab: () => {
  const { filters } = useFilters();
  const scope = useTrendsDataScope();
  useTrendsApi("/v1/timeseries");
  return <output data-testid="chart-scope">{JSON.stringify({ ...scope, filters })}</output>;
} }));

const ALPHA = `p_${"a".repeat(22)}`;
const BETA = `p_${"b".repeat(22)}`;
const LEGACY = `p_${"c".repeat(22)}`;

const PLAYERS = [
  { playerId: ALPHA, displayName: "Alpha", race: "P", currentMmr: 5210, mmrSource: "pulse", mmrUpdatedAt: "2026-09-12T10:00:00Z", gameCount: 320, lastSeen: "2026-09-12T10:00:00Z", included: true },
  { playerId: BETA, displayName: "Beta", race: "T", currentMmr: 4300, mmrSource: "replay", mmrUpdatedAt: "2026-09-10T10:00:00Z", gameCount: 180, lastSeen: "2026-09-10T10:00:00Z", included: true },
  { playerId: LEGACY, displayName: "Legacy", race: "U", currentMmr: null, mmrSource: null, mmrUpdatedAt: null, gameCount: 5, lastSeen: null, included: true },
];

async function renderWithPlayers() {
  const page = render(<AdminGlobalTrendsPage />);
  await screen.findByRole("region", { name: "Player population" });
  return page;
}

function scope() { return JSON.parse(screen.getByTestId("chart-scope").textContent!); }

beforeEach(() => {
  navigation.search = "";
  const options = { maps: ["Ancient Cistern"], builds: ["Gateway Expand"], strategies: ["Bio"] };
  const roster = { items: PLAYERS, total: 103, page: 0, limit: 50, hasMore: true, selectedTotal: 103 };
  api.useApi.mockImplementation((path: string) => ({
    data: path.includes("filter-options") ? options : roster,
    error: undefined, isLoading: false, mutate: api.mutate,
  }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Global Trends", () => {
  it("starts with all histories and displays source-aware player ratings", async () => {
    await renderWithPlayers();
    expect(screen.getByRole("heading", { name: "Global trends" })).toBeTruthy();
    expect(screen.getByText("5,210")).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.getByText(/SC2Pulse ·/)).toBeTruthy();
    expect(screen.getByText(/Latest replay ·/)).toBeTruthy();
    expect(scope().mode).toBe("global");
    expect(scope().filters).toEqual({ preset: "all", map_pool: "all", game_size: "all", exclude_too_short: false });
  });

  it("stages exclusions and applies race, player, and MMR filters together", async () => {
    await renderWithPlayers();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Zerg" }));
    fireEvent.change(screen.getByLabelText("Current player MMR · minimum"), { target: { value: "4500" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Include players without MMR" }));
    const map = screen.getByLabelText("Map", { exact: true });
    fireEvent.change(map, { target: { value: "Ancient Cistern" } });
    expect(screen.getByText("5 changes pending")).toBeTruthy();
    expect(scope().cohort.excluded_players).toBeUndefined();
    expect(scope().filters.map).toBeUndefined();
    expect(navigation.replace).not.toHaveBeenCalled();
    fireEvent.keyDown(map, { key: "Enter" });
    expect(scope().filters.map).toBe("Ancient Cistern");
    expect(scope().cohort).toMatchObject({ excluded_players: ALPHA, excluded_races: "Z", player_mmr_min: 4500, include_unrated: false });
  });

  it("keeps a cleared selection empty and supports focusing one player", async () => {
    await renderWithPlayers();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(scope().cohort.player_selection).toBe("include");
    expect(scope().cohort.included_players).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Only include Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(scope().cohort.included_players).toBe(BETA);
  });

  it("blocks inverted ranges and resets all population constraints", async () => {
    await renderWithPlayers();
    fireEvent.change(screen.getByLabelText("Current player MMR · minimum"), { target: { value: "5000" } });
    fireEvent.change(screen.getByLabelText("Current player MMR · maximum"), { target: { value: "3000" } });
    expect(screen.getByRole("alert").textContent).toContain("Minimum MMR");
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(scope().cohort).toEqual({ player_selection: "all", include_unrated: true, cohort_refs: 1 });
  });

  it("searches and pages the full roster without changing the chart cohort", async () => {
    await renderWithPlayers();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(api.useApi.mock.calls.some(([path]) => String(path).includes("page=1"))).toBe(true);
    fireEvent.change(screen.getByLabelText("Search players"), { target: { value: "Alpha" } });
    await waitFor(() => expect(api.useApi.mock.calls.some(([path]) => String(path).includes("search=Alpha") && String(path).includes("page=0"))).toBe(true));
    expect(scope().cohort).toEqual({ player_selection: "all", include_unrated: true, cohort_refs: 1 });
  });

  it("applies detailed game filters without dropping the population", async () => {
    await renderWithPlayers();
    fireEvent.click(screen.getByRole("button", { name: "Only include Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.change(screen.getByLabelText("Map", { exact: true }), { target: { value: "Ancient Cistern" } });
    fireEvent.change(screen.getByLabelText("Opponent MMR · minimum"), { target: { value: "4000" } });
    fireEvent.change(screen.getByLabelText("Opponent race", { exact: true }), { target: { value: "T" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(scope().filters).toMatchObject({ map: "Ancient Cistern", mmr_min: 4000, opp_race: "T" });
    expect(scope().cohort.included_players).toBe(ALPHA);
  });

  it.each(["filter-options", "players", "timeseries"])("shows a page-level 403 from %s without probing /v1/me", async resource => {
    api.useApi.mockImplementation((path: string) => path.includes(`/global-trends/${resource}`)
      ? { error: { status: 403, message: "Forbidden" }, mutate: api.mutate }
      : { data: undefined, isLoading: false, mutate: api.mutate });
    render(<AdminGlobalTrendsPage />);
    expect(await screen.findByText("403 — admin only")).toBeTruthy();
    expect(screen.queryByTestId("chart-scope")).toBeNull();
    expect(api.useApi.mock.calls.some(([path]) => String(path).startsWith("/v1/me"))).toBe(false);
  });

  it.each(["loading", "error"])("loads players and charts independently while filter suggestions are %s", async (state) => {
    const roster = { items: PLAYERS, total: 3, selectedTotal: 3, hasMore: false };
    api.useApi.mockImplementation((path: string) => path.includes("filter-options")
      ? { data: undefined, isLoading: state === "loading", error: state === "error" ? { status: 0, message: "The API is unavailable." } : undefined, mutate: api.mutate }
      : { data: roster, isLoading: false, mutate: api.mutate });
    await renderWithPlayers();
    expect(screen.getByText("5,210")).toBeTruthy();
    expect(screen.getByRole("region", { name: "All-player trend charts" })).toBeTruthy();
    expect(scope().mode).toBe("global");
    if (state === "error") {
      fireEvent.click(screen.getByRole("button", { name: "Retry filter suggestions" }));
      expect(api.mutate).toHaveBeenCalledOnce();
    }
  });

  it("retains unfinished player and game filters while refreshing suggestions", async () => {
    let refreshing = false;
    const roster = { items: PLAYERS, total: 3, selectedTotal: 3, hasMore: false };
    api.useApi.mockImplementation((path: string) => path.includes("filter-options")
      ? { data: refreshing ? undefined : { maps: ["Ancient Cistern"], builds: [], strategies: [] }, isLoading: refreshing, mutate: api.mutate }
      : { data: roster, isLoading: false, mutate: api.mutate });
    await renderWithPlayers();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include Alpha" }));
    fireEvent.change(screen.getByLabelText("Current player MMR · minimum"), { target: { value: "4500" } });
    fireEvent.change(screen.getByLabelText("Map", { exact: true }), { target: { value: "Ancient Cistern" } });
    refreshing = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh data" }));
    expect((screen.getByRole("checkbox", { name: "Include Alpha" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Current player MMR · minimum") as HTMLInputElement).value).toBe("4500");
    expect((screen.getByLabelText("Map", { exact: true }) as HTMLInputElement).value).toBe("Ancient Cistern");
    expect(scope().mode).toBe("global");
  });

  it("shows applied population membership independently of manual selection", async () => {
    const roster = { items: PLAYERS.map((p) => ({ ...p, included: p.playerId === PLAYERS[0].playerId })), total: 3, rosterTotal: 3, selectedTotal: 1, hasMore: false };
    const options = { maps: [], builds: [], strategies: [] };
    api.useApi.mockImplementation((path: string) => ({ data: path.includes("filter-options") ? options : roster, isLoading: false, mutate: api.mutate }));
    await renderWithPlayers();
    expect(screen.getByText("1 of 3 players included")).toBeTruthy();
    expect(screen.getAllByText("Filtered out")).toHaveLength(2);
    expect((screen.getByRole("checkbox", { name: "Include Beta" }) as HTMLInputElement).checked).toBe(true);
  });

  it("shows a retry action instead of treating a failed directory as empty", async () => {
    const options = { maps: [], builds: [], strategies: [] };
    api.useApi.mockImplementation((path: string) => path.includes("filter-options")
      ? { data: options, isLoading: false, mutate: api.mutate }
      : { error: { status: 500, message: "Try later." }, isLoading: false, mutate: api.mutate });
    await renderWithPlayers();
    expect(screen.getByRole("alert").textContent).toContain("Could not load players");
    fireEvent.click(screen.getByRole("button", { name: "Retry player directory" }));
    expect(api.mutate).toHaveBeenCalledOnce();
  });

  it("refreshes server caches as well as chart and roster request identities", async () => {
    await renderWithPlayers();
    fireEvent.click(screen.getByRole("button", { name: "Refresh data" }));
    const token = scope().cohort.refresh_after;
    expect(token).toBeGreaterThan(0);
    for (const resource of ["filter-options", "players"]) {
      expect(api.useApi.mock.calls.some(([path]) => String(path).includes(`/${resource}?`) && String(path).includes(`refresh_after=${token}`))).toBe(true);
    }
  });

  it("round-trips an opaque URL, removes a filter immediately and keeps other pending edits", async () => {
    navigation.search = new URLSearchParams({ pids: ALPHA, sel: "include", xr: "R", mmin: "4000", mmax: "5000", unrated: "0", map: "Ancient Cistern" }).toString();
    await renderWithPlayers();
    expect(scope().cohort).toMatchObject({ included_players: ALPHA, excluded_races: "R", player_mmr_min: 4000, player_mmr_max: 5000, include_unrated: false });
    expect(scope().filters.map).toBe("Ancient Cistern");
    fireEvent.change(screen.getByLabelText("Player build"), { target: { value: "Gateway Expand" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Excluding Random" }));
    expect(scope().cohort.excluded_races).toBeUndefined();
    expect(scope().filters.build).toBeUndefined();
    expect(screen.getByText("1 change pending")).toBeTruthy();
    const [href, options] = navigation.replace.mock.lastCall!;
    expect(options).toEqual({ scroll: false });
    expect(href).not.toContain("xr=");
    expect(readTrendView(new URL(String(href), "https://example.test").searchParams).view.population.playerIds).toEqual([ALPHA]);
  });

  it("uses defaults for invalid URL values and removes raw identity parameters", async () => {
    navigation.search = "preset=invalid&pids=&pids=1-S2-1-111&accounts=2-S2-1-222&mmin=bad&xr=Q";
    await renderWithPlayers();
    expect(screen.getByText(/Some filters in this link were invalid/)).toBeTruthy();
    expect(scope().filters.preset).toBe("all");
    expect(scope().cohort.excluded_players).toBeUndefined();
    expect(String(navigation.replace.mock.lastCall?.[0])).not.toMatch(/1-S2-1-111|2-S2-1-222|pids=|accounts=/);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Some filters in this link were invalid/)).toBeNull();
  });

  it("omits more than 50 players from URLs without replacing the applied cohort", async () => {
    const many = Array.from({ length: 51 }, (_, index) => ({ ...PLAYERS[0], playerId: `p_${index.toString().padStart(22, "0")}`, displayName: `Player ${index}` }));
    api.useApi.mockImplementation((path: string) => ({ data: path.includes("/players") ? { items: many, total: 51, selectedTotal: 51 } : undefined, mutate: api.mutate }));
    const page = await renderWithPlayers();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    fireEvent.click(screen.getByRole("button", { name: "Include page" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByText(/Too many players to share by link/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Copy view link" }) as HTMLButtonElement).disabled).toBe(true);
    const href = String(navigation.replace.mock.lastCall?.[0]);
    expect(href).not.toContain("pids=");
    navigation.search = new URL(href, "https://example.test").search;
    page.rerender(<AdminGlobalTrendsPage />);
    expect(scope().cohort.included_players.split(",")).toHaveLength(51);
  });

  it("saves, renames and deletes only private views while preserving the built-in presets", async () => {
    let data: TrendViewPreferences = { revision: 0, views: [] };
    api.useApi.mockImplementation((path: string) => path.endsWith("/adminTrendViews") ? {
      data, request: api.request, mutate: (next: TrendViewPreferences) => { data = next; },
    } : { data: path.includes("/players") ? { items: PLAYERS, total: 3, selectedTotal: 3 } : undefined, mutate: api.mutate });
    api.request.mockImplementation(async (init: RequestInit) => {
      const input = JSON.parse(String(init.body));
      expect(input.revision).toBe(data.revision);
      return { ...input, revision: input.revision + 1 };
    });
    await renderWithPlayers();
    fireEvent.click(screen.getByRole("button", { name: "Only include Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Global Trends views" }));
    const name = dialog.getByLabelText("View name");
    fireEvent.change(name, { target: { value: "My cohort" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save current view" }));
    await dialog.findByRole("button", { name: "Rename My cohort" });
    expect(data.views[0].population.playerIds).toEqual([ALPHA]);
    expect(trendViewQuery({ ...DEFAULT_TREND_VIEW, ...data.views[0] }).get("pids")).toBe(ALPHA);
    fireEvent.change(name, { target: { value: "my COHORT" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save current view" }));
    expect(dialog.getByRole("alert").textContent).toContain("already exists");
    fireEvent.click(dialog.getByRole("button", { name: "Rename My cohort" }));
    fireEvent.change(dialog.getByLabelText("Rename view"), { target: { value: "Renamed cohort" } });
    fireEvent.click(dialog.getByRole("button", { name: "Rename" }));
    fireEvent.click(await dialog.findByRole("button", { name: "Delete Renamed cohort" }));
    await waitFor(() => expect(dialog.queryByRole("button", { name: "Delete Renamed cohort" })).toBeNull());
    expect(dialog.getByRole("button", { name: "Apply Exclude Random" })).toBeTruthy();
    expect(dialog.queryByRole("button", { name: "Delete Exclude Random" })).toBeNull();
    expect(api.request).toHaveBeenCalledTimes(3);
  });

  it("keeps page batch changes reversible across selection modes", () => {
    const excluded = selectPlayers(ALL_PLAYERS, ["a", "b"], false);
    expect(populationQuery(excluded).excluded_players).toBe("a,b");
    expect(selectPlayers(excluded, ["a"], true).playerIds).toEqual(["b"]);
    const included = selectPlayers({ ...ALL_PLAYERS, selection: "include" }, ["a", "b"], true);
    expect(populationQuery(included).included_players).toBe("a,b");
    expect(selectPlayers(included, ["a"], false).playerIds).toEqual(["b"]);
  });
});
