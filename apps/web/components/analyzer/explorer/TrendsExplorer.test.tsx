import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FiltersContext, type FiltersValue } from "@/lib/filterContext";
import { TrendsDataProvider } from "@/lib/trendsDataContext";
import type { ExplorerResponse } from "@/lib/trendsExplorer";
import { TrendsExplorer } from "./TrendsExplorer";
import { validateExplorerControls } from "./ExplorerControls";

const useApiMock = vi.fn();
const retry = vi.fn();
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string, config: unknown) => useApiMock(path, config) }));
vi.mock("recharts", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Stub = () => null;
  return { ResponsiveContainer: Wrapper, ComposedChart: Wrapper, Area: Stub, Bar: Stub, Cell: Stub, Line: Stub, ReferenceLine: Stub, XAxis: Stub, YAxis: Stub, Tooltip: Stub, CartesianGrid: Stub };
});

const rows = [{ key: "near", label: "Near equal MMR", games: 12, wins: 7, losses: 5, decided: 12, winRate: 7 / 12, players: 2, medianSec: 300, p25Sec: 280, p75Sec: 320 }];
const fixture: ExplorerResponse = {
  view: "mmr-gap", totalGames: 20, eligibleGames: 12, notes: ["Only recorded game-time ratings are used."], rows,
  options: { players: [{ id: "account-a", label: "Alpha", currentMmr: 4510 }, { id: "account-b", label: "Beta", currentMmr: null }], builds: ["Two-base timing"], milestones: [{ id: "third-base", label: "Third base" }, { id: "first-upgrade", label: "First upgrade" }] },
};
const filterValue: FiltersValue = { filters: { race: "P", regions: "NA,EU", since: "2026-01-01", build: "Page build" }, setFilters: vi.fn(), dbRev: 9, bumpRev: vi.fn(), seasons: [] };
function mount(global = false, isNearViewport = true) {
  return render(<FiltersContext.Provider value={filterValue}><TrendsDataProvider mode={global ? "global" : "personal"} cohort={global ? { excluded_players: "excluded-account", player_races: "P,T" } : {}}><TrendsExplorer isNearViewport={isNearViewport} /></TrendsDataProvider></FiltersContext.Provider>);
}
function lastPath() { return useApiMock.mock.calls.at(-1)![0] as string; }
function params(path = lastPath()) { return new URL(path, "https://example.test").searchParams; }

beforeEach(() => { useApiMock.mockImplementation(() => ({ data: fixture, isLoading: false, error: undefined, mutate: retry })); });
afterEach(() => { cleanup(); useApiMock.mockReset(); retry.mockReset(); });

describe("TrendsExplorer real data navigation and filtering", () => {
  it("requests only the active analysis and preserves all page filters and revision", () => {
    mount();
    expect(useApiMock).toHaveBeenCalledTimes(1);
    expect(lastPath()).toContain("/v1/trends/explorer/mmr-gap?");
    expect(lastPath()).toMatch(/#9$/);
    expect(params().get("race")).toBe("P");
    expect(params().get("regions")).toBe("NA,EU");
    expect(params().get("build")).toBe("Page build");
    useApiMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Breaks & results" }));
    expect(useApiMock.mock.calls.every(([path]) => path.includes("/breaks?"))).toBe(true);
    fireEvent.change(screen.getByLabelText("Previous game result"), { target: { value: "loss" } });
    expect(params().get("after")).toBe("loss");
  });

  it("scopes global analysis and drilldown requests to the same selected population", () => {
    mount(true);
    expect(lastPath()).toContain("/v1/admin/global-trends/trends/explorer/mmr-gap?");
    expect(params().get("excluded_players")).toBe("excluded-account");
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    useApiMock.mockImplementation((path: string) => path.includes("/games?") ? { data: { total: 0, offset: 0, limit: 20, games: [] }, isLoading: false, mutate: retry } : { data: fixture, isLoading: false, mutate: retry });
    fireEvent.click(screen.getAllByRole("button", { name: "View games for Near equal MMR" })[0]);
    const gamePath = useApiMock.mock.calls.findLast(([path]) => path.includes("/games?"))![0];
    expect(gamePath).toContain("/v1/admin/global-trends/trends/explorer/mmr-gap/games?");
    expect(params(gamePath).get("segment")).toBe("near");
    expect(params(gamePath).get("excluded_players")).toBe("excluded-account");
    expect(params(gamePath).get("gap_width")).toBe("200");
    expect(params(gamePath).get("build")).toBe("Page build");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("offers the same seven analyses in the compact mobile selector", () => {
    mount();
    const selector = screen.getByLabelText("Choose performance analysis");
    expect(within(selector).getAllByRole("option")).toHaveLength(7);
    fireEvent.change(selector, { target: { value: "rematches" } });
    expect(lastPath()).toContain("/rematches?");
    fireEvent.change(screen.getByLabelText("Previous encounter result"), { target: { value: "win" } });
    expect(params().get("after")).toBe("win");
  });

  it("does not request incomplete date edits until a valid comparison is applied", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Compare periods" }));
    useApiMock.mockClear();
    fireEvent.change(screen.getByLabelText("Period A start"), { target: { value: "2026-02-20" } });
    fireEvent.change(screen.getByLabelText("Period A end"), { target: { value: "2026-02-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply comparison" }));
    expect(useApiMock).not.toHaveBeenCalled();
    expect(screen.getByText("Each start date must be on or before its end date.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Period A end"), { target: { value: "2026-02-28" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply comparison" }));
    expect(params().get("a_since")).toBe("2026-02-20");
    expect(params().get("a_until")).toBe("2026-02-28");
    expect(params().get("race")).toBe("P");
  });

  it("sends explicit unbounded MMR ranges and preserves them when revisiting a view", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Compare groups" }));
    fireEvent.change(screen.getByLabelText("Group A minimum MMR"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Group A upper MMR bound"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply comparison" }));
    expect(params().get("a_min")).toBe("0");
    expect(params().get("a_max")).toBe("10001");
    fireEvent.click(screen.getByRole("button", { name: "MMR difference" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare groups" }));
    expect((screen.getByLabelText("Group A minimum MMR") as HTMLInputElement).value).toBe("");
    expect(params().get("a_max")).toBe("10001");
  });

  it("supports selected account comparisons with current MMR and equal-player weighting", () => {
    mount(true);
    fireEvent.click(screen.getByRole("button", { name: "Compare groups" }));
    fireEvent.change(screen.getByLabelText("Compare by"), { target: { value: "players" } });
    fireEvent.change(screen.getByLabelText("Weight results"), { target: { value: "players" } });
    const groupA = screen.getByRole("group", { name: "Group A" });
    const groupB = screen.getByRole("group", { name: "Group B" });
    fireEvent.click(within(groupA).getByRole("checkbox", { name: /Alpha/ }));
    fireEvent.click(within(groupB).getByRole("checkbox", { name: /Beta/ }));
    expect(within(groupA).getByText("4,510 MMR")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply comparison" }));
    expect(params().get("a_players")).toBe("account-a");
    expect(params().get("b_players")).toBe("account-b");
    expect(params().get("weight")).toBe("players");
    expect(screen.getByText("player-weighted win rate")).toBeTruthy();
  });

  it("inherits the page build until execution explicitly selects another build", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Build execution" }));
    expect(params().get("build")).toBe("Page build");
    fireEvent.change(screen.getByLabelText("Build", { exact: true }), { target: { value: "Two-base timing" } });
    expect(params().get("build")).toBe("Two-base timing");
    fireEvent.change(screen.getByLabelText("Build", { exact: true }), { target: { value: "" } });
    expect(params().get("build")).toBe("Page build");
    fireEvent.change(screen.getByLabelText("Timing period"), { target: { value: "month" } });
    expect(params().get("interval")).toBe("month");
  });

  it("keeps account choices visible during a same-scope comparison reload", () => {
    mount(true);
    fireEvent.click(screen.getByRole("button", { name: "Compare groups" }));
    fireEvent.change(screen.getByLabelText("Compare by"), { target: { value: "players" } });
    fireEvent.click(within(screen.getByRole("group", { name: "Group A" })).getByRole("checkbox", { name: /Alpha/ }));
    fireEvent.click(within(screen.getByRole("group", { name: "Group B" })).getByRole("checkbox", { name: /Beta/ }));
    useApiMock.mockReturnValue({ data: undefined, isLoading: true, mutate: retry });
    fireEvent.click(screen.getByRole("button", { name: "Apply comparison" }));
    expect(within(screen.getByRole("group", { name: "Group A" })).getByRole("checkbox", { name: /Alpha/ })).toBeTruthy();
    expect(screen.queryByText("No player accounts available for this selection.")).toBeNull();
    expect(screen.getByRole("status", { name: "Loading Compare player groups" })).toBeTruthy();
  });

  it("clears prior account options when the authorized player population changes", () => {
    const rendered = mount(true);
    fireEvent.click(screen.getByRole("button", { name: "Compare groups" }));
    fireEvent.change(screen.getByLabelText("Compare by"), { target: { value: "players" } });
    expect(within(screen.getByRole("group", { name: "Group A" })).getByRole("checkbox", { name: /Alpha/ })).toBeTruthy();
    useApiMock.mockReturnValue({ data: undefined, isLoading: true, mutate: retry });
    rendered.rerender(<FiltersContext.Provider value={filterValue}><TrendsDataProvider mode="global" cohort={{ excluded_players: "account-a,account-b" }}><TrendsExplorer /></TrendsDataProvider></FiltersContext.Provider>);
    expect(screen.queryByRole("checkbox", { name: /Alpha/ })).toBeNull();
  });

  it("keeps controls available on errors and retries only the active analysis", () => {
    useApiMock.mockReturnValue({ isLoading: false, error: { message: "Request timed out" }, mutate: retry });
    mount();
    expect(screen.getByRole("alert").textContent).toContain("Request timed out");
    expect(screen.getByLabelText("MMR difference band")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith();
  });

  it.each([false, true])("keeps the loading state between clearing a retry error and receiving data (global=%s)", (global) => {
    useApiMock.mockReturnValue({ data: undefined, isLoading: false, error: undefined, mutate: retry });
    mount(global);
    expect(screen.getByRole("status", { name: "Loading Performance by MMR difference" })).toBeTruthy();
    expect(screen.queryByText("No eligible games for this analysis")).toBeNull();
    expect(screen.queryByText("Games analyzed")).toBeNull();
    expect(screen.getByLabelText("MMR difference band")).toBeTruthy();
  });

  it("keeps game drilldowns loading when a retry has no response and no error yet", () => {
    useApiMock.mockImplementation((path: string) => path.includes("/games?") ? { data: undefined, isLoading: false, error: undefined, mutate: retry } : { data: fixture, isLoading: false, mutate: retry });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    fireEvent.click(screen.getAllByRole("button", { name: "View games for Near equal MMR" })[0]);
    expect(screen.getByRole("status", { name: "Loading analysis games" })).toBeTruthy();
    expect(screen.queryByText("No games match this group")).toBeNull();
    expect(screen.getByText("Loading games…")).toBeTruthy();
  });

  it("retries a failed game drilldown without passing the click event into its cache", () => {
    useApiMock.mockImplementation((path: string) => path.includes("/games?") ? { data: undefined, isLoading: false, error: { message: "Games request timed out" }, mutate: retry } : { data: fixture, isLoading: false, mutate: retry });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    fireEvent.click(screen.getAllByRole("button", { name: "View games for Near equal MMR" })[0]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith();
  });

  it("shows zero coverage honestly and polls while real measurements are prepared", () => {
    useApiMock.mockReturnValue({ data: { ...fixture, eligibleGames: 0, rows: [], preparation: { pendingGames: 18 } }, isLoading: false, mutate: retry });
    mount();
    expect(screen.getByText("0.0%")).toBeTruthy();
    expect(screen.getByText("Of 20 selected games")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("18 games");
    expect(screen.getByText("No eligible games for this analysis")).toBeTruthy();
    const config = useApiMock.mock.calls[0][1];
    expect(config.refreshInterval({ preparation: { pendingGames: 18 } })).toBe(15000);
    expect(config.refreshInterval({ preparation: { pendingGames: 0 } })).toBe(0);
  });

  it.each([{ global: false, interval: 15000 }, { global: true, interval: 60000 }])("uses $interval ms for active preparation polling (global=$global)", ({ global, interval }) => {
    mount(global);
    const config = useApiMock.mock.calls[0][1];
    expect(config.refreshInterval({ preparation: { pendingGames: 18 } })).toBe(interval);
    expect(config.refreshInterval({ preparation: { pendingGames: 0 } })).toBe(0);
  });

  it.each([false, true])("pauses preparation polling offscreen without discarding results (global=%s)", (global) => {
    mount(global, false);
    expect(useApiMock.mock.calls[0][1].refreshInterval({ preparation: { pendingGames: 18 } })).toBe(0);
    expect(screen.getByText("Games analyzed")).toBeTruthy();
    expect(screen.getByText("60.0%")).toBeTruthy();
  });

  it.each([false, true])("pauses preparation polling during game drilldowns and resumes on close (global=%s)", (global) => {
    useApiMock.mockImplementation((path: string) => path.includes("/games?") ? { data: { total: 0, offset: 0, limit: 20, games: [] }, isLoading: false, mutate: retry } : { data: { ...fixture, preparation: { pendingGames: 18 } }, isLoading: false, mutate: retry });
    mount(global);
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    fireEvent.click(screen.getAllByRole("button", { name: "View games for Near equal MMR" })[0]);
    const panelConfig = () => useApiMock.mock.calls.findLast(([path]) => !path.includes("/games?"))![1];
    expect(panelConfig().refreshInterval({ preparation: { pendingGames: 18 } })).toBe(0);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(panelConfig().refreshInterval({ preparation: { pendingGames: 18 } })).toBe(global ? 60000 : 15000);
  });

  it("paginates the exact selected games and retains the segment", () => {
    useApiMock.mockImplementation((path: string) => path.includes("/games?") ? { data: { total: 21, offset: Number(params(path).get("offset")), limit: 20, games: Array.from({ length: Number(params(path).get("offset")) ? 1 : 20 }, (_, index) => ({ id: `game-${index}`, date: "2026-09-01T12:00:00Z", result: "Win", playerId: "account-a", playerName: "Alpha", opponent: "Beta", durationSec: 600 })) }, isLoading: false, mutate: retry } : { data: fixture, isLoading: false, mutate: retry });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    fireEvent.click(screen.getAllByRole("button", { name: "View games for Near equal MMR" })[0]);
    expect(screen.getByText("1–20 of 21 games")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next games" }));
    expect(params().get("offset")).toBe("20");
    expect(params().get("segment")).toBe("near");
    expect(screen.getByText("21–21 of 21 games")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next games" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("comparison input validation", () => {
  it("rejects backwards MMR ranges and empty player groups", () => {
    expect(validateExplorerControls("groups", { group_mode: "mmr", a_min: 5000, a_max: 4000 })).toContain("upper MMR bound");
    expect(validateExplorerControls("groups", { group_mode: "players", a_players: "a", b_players: "" })).toContain("each group");
    expect(validateExplorerControls("groups", { group_mode: "mmr", a_min: "", a_max: "", b_min: 4000, b_max: 5000 })).toBeNull();
  });
});
