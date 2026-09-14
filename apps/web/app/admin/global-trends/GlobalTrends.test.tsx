import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AdminGlobalTrendsPage from "./page";
import { useFilters } from "@/lib/filterContext";
import { useTrendsDataScope } from "@/lib/trendsDataContext";
import { ALL_PLAYERS, populationQuery, selectPlayers } from "./globalTrendsState";

const api = vi.hoisted(() => ({ useApi: vi.fn(), mutate: vi.fn() }));
vi.mock("@/lib/clientApi", () => ({ useApi: api.useApi }));
vi.mock("@/lib/useSeasons", () => ({ useSeasons: () => ({ data: { items: [] } }), rollUpSeasons: () => [] }));
vi.mock("@/components/analyzer/TrendsTab", () => ({ TrendsTab: () => {
  const { filters } = useFilters();
  const scope = useTrendsDataScope();
  return <output data-testid="chart-scope">{JSON.stringify({ ...scope, filters })}</output>;
} }));

const PLAYERS = [
  { playerId: "1-S2-1-111", displayName: "Alpha", race: "P", currentMmr: 5210, mmrSource: "pulse", mmrUpdatedAt: "2026-09-12T10:00:00Z", gameCount: 320, lastSeen: "2026-09-12T10:00:00Z", included: true },
  { playerId: "2-S2-1-222", displayName: "Beta", race: "T", currentMmr: 4300, mmrSource: "replay", mmrUpdatedAt: "2026-09-10T10:00:00Z", gameCount: 180, lastSeen: "2026-09-10T10:00:00Z", included: true },
  { playerId: "user:legacy", displayName: "Legacy", race: "U", currentMmr: null, mmrSource: null, mmrUpdatedAt: null, gameCount: 5, lastSeen: null, included: true },
];

function scope() { return JSON.parse(screen.getByTestId("chart-scope").textContent!); }

beforeEach(() => {
  const options = { maps: ["Ancient Cistern"], builds: ["Gateway Expand"], strategies: ["Bio"] };
  const roster = { items: PLAYERS, total: 103, page: 0, limit: 50, hasMore: true, selectedTotal: 103 };
  api.useApi.mockImplementation((path: string) => ({
    data: path.includes("filter-options") ? options : roster,
    error: undefined, isLoading: false, mutate: api.mutate,
  }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Global Trends", () => {
  it("starts with all histories and displays source-aware player ratings", () => {
    render(<AdminGlobalTrendsPage />);
    expect(screen.getByRole("heading", { name: "Global Trends" })).toBeTruthy();
    expect(screen.getByText("5,210")).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.getByText(/SC2Pulse ·/)).toBeTruthy();
    expect(screen.getByText(/Latest replay ·/)).toBeTruthy();
    expect(scope().mode).toBe("global");
    expect(scope().filters).toEqual({ preset: "all", map_pool: "all", game_size: "all", exclude_too_short: false });
  });

  it("stages exclusions and applies race, player, and MMR filters together", () => {
    render(<AdminGlobalTrendsPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Include Alpha (1-S2-1-111)" }));
    fireEvent.click(screen.getByRole("button", { name: "Zerg" }));
    fireEvent.change(screen.getByLabelText("Current player MMR · minimum"), { target: { value: "4500" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Include players without MMR" }));
    expect(scope().cohort.excluded_players).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Apply player filters" }));
    expect(scope().cohort).toMatchObject({ excluded_players: "1-S2-1-111", excluded_races: "Z", player_mmr_min: 4500, include_unrated: false });
  });

  it("keeps a cleared selection empty and supports focusing one player", () => {
    render(<AdminGlobalTrendsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply player filters" }));
    expect(scope().cohort.player_selection).toBe("include");
    expect(scope().cohort.included_players).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Only include Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply player filters" }));
    expect(scope().cohort.included_players).toBe("2-S2-1-222");
  });

  it("blocks inverted ranges and resets all population constraints", () => {
    render(<AdminGlobalTrendsPage />);
    fireEvent.change(screen.getByLabelText("Current player MMR · minimum"), { target: { value: "5000" } });
    fireEvent.change(screen.getByLabelText("Current player MMR · maximum"), { target: { value: "3000" } });
    expect(screen.getByRole("alert").textContent).toContain("Minimum MMR");
    expect((screen.getByRole("button", { name: "Apply player filters" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reset player filters" }));
    expect(scope().cohort).toEqual({ player_selection: "all", include_unrated: true });
  });

  it("searches and pages the full roster without changing the chart cohort", async () => {
    render(<AdminGlobalTrendsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(api.useApi.mock.calls.some(([path]) => String(path).includes("page=1"))).toBe(true);
    fireEvent.change(screen.getByLabelText("Search players"), { target: { value: "Alpha" } });
    await waitFor(() => expect(api.useApi.mock.calls.some(([path]) => String(path).includes("search=Alpha") && String(path).includes("page=0"))).toBe(true));
    expect(scope().cohort).toEqual({ player_selection: "all", include_unrated: true });
  });

  it("applies detailed game filters without dropping the population", () => {
    render(<AdminGlobalTrendsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Only include Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply player filters" }));
    fireEvent.change(screen.getByLabelText("Map", { exact: true }), { target: { value: "Ancient Cistern" } });
    fireEvent.change(screen.getByLabelText("Opponent MMR · minimum"), { target: { value: "4000" } });
    fireEvent.change(screen.getByLabelText("Opponent race", { exact: true }), { target: { value: "T" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply detailed filters" }));
    expect(scope().filters).toMatchObject({ map: "Ancient Cistern", mmr_min: 4000, opp_race: "T" });
    expect(scope().cohort.included_players).toBe("1-S2-1-111");
  });

  it("never mounts population data or charts after an admin denial", () => {
    api.useApi.mockReturnValue({ data: undefined, error: { status: 403, message: "Forbidden" }, isLoading: false });
    render(<AdminGlobalTrendsPage />);
    expect(screen.queryByTestId("chart-scope")).toBeNull();
    expect(api.useApi.mock.calls.every(([path]) => String(path).includes("filter-options"))).toBe(true);
  });

  it("shows applied population membership independently of manual selection", () => {
    const roster = { items: PLAYERS.map((p) => ({ ...p, included: p.playerId === PLAYERS[0].playerId })), total: 3, rosterTotal: 3, selectedTotal: 1, hasMore: false };
    const options = { maps: [], builds: [], strategies: [] };
    api.useApi.mockImplementation((path: string) => ({ data: path.includes("filter-options") ? options : roster, isLoading: false, mutate: api.mutate }));
    render(<AdminGlobalTrendsPage />);
    expect(screen.getByText("1 of 3 players included")).toBeTruthy();
    expect(screen.getAllByText("Filtered out")).toHaveLength(2);
    expect((screen.getByRole("checkbox", { name: "Include Beta (2-S2-1-222)" }) as HTMLInputElement).checked).toBe(true);
  });

  it("shows a retry action instead of treating a failed directory as empty", () => {
    const options = { maps: [], builds: [], strategies: [] };
    api.useApi.mockImplementation((path: string) => path.includes("filter-options")
      ? { data: options, isLoading: false, mutate: api.mutate }
      : { error: { status: 500, message: "Try later." }, isLoading: false, mutate: api.mutate });
    render(<AdminGlobalTrendsPage />);
    expect(screen.getByRole("alert").textContent).toContain("Could not load players");
    fireEvent.click(screen.getByRole("button", { name: "Retry player directory" }));
    expect(api.mutate).toHaveBeenCalledOnce();
  });

  it("refreshes server caches as well as chart and roster request identities", () => {
    render(<AdminGlobalTrendsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh data" }));
    const token = scope().cohort.refresh_after;
    expect(token).toBeGreaterThan(0);
    for (const resource of ["filter-options", "players"]) {
      expect(api.useApi.mock.calls.some(([path]) => String(path).includes(`/${resource}?`) && String(path).includes(`refresh_after=${token}`))).toBe(true);
    }
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
