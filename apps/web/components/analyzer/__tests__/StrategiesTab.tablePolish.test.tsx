import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AnalyzerFilters } from "@/lib/filterContext";
const state = vi.hoisted(() => ({ filters: {} as AnalyzerFilters, paths: [] as (string | null)[], noGames: false, previous: false, options: [] as unknown[] }));
const csv = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock("@/lib/csvExport", async original => ({ ...(await original<typeof import("@/lib/csvExport")>()), downloadCsv: csv.download }));
const rows = [
  { my_build: "Z Build", opp_strat: "Z Strategy", wins: 8, losses: 2, total: 10, winRate: .8, myMatchups: { P: 8, T: 2 } },
  { my_build: "A Build", opp_strat: "A Strategy", wins: 2, losses: 2, total: 4, winRate: .5, myMatchups: { P: 4 } },
];
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string | null, options?: unknown) => {
  state.paths.push(path);
  if (!path) return { data: undefined, isLoading: false };
  if (path.startsWith("/v1/build-vs-strategy")) return { data: path.includes("opp_race=T") ? [rows[1]] : rows, isLoading: false };
  if (path.startsWith("/v1/games-list")) { state.options.push(options); return { data: { total: state.noGames ? 0 : 1, games: state.noGames ? [] : [{ id: "g1", result: "Win", build: "Z Build", opp_strategy: "Z Strategy", opp_race: "Protoss" }] }, isPreviousData: state.previous, isLoading: state.previous }; }
  if (path.includes("/phases")) return { data: undefined, error: { status: 404 }, isLoading: false };
  return { data: [], isLoading: false };
} }));
vi.mock("@/lib/filterContext", async original => ({ ...(await original<typeof import("@/lib/filterContext")>()), useFilters: () => ({ filters: state.filters, setFilters: vi.fn(), dbRev: 4, seasons: [] }) }));
vi.mock("@/lib/useMyDisplayName", () => ({ useMyDisplayName: () => "Owner" }));
vi.mock("../mmr/StrategyMmrPanel", () => ({ StrategyMmrPanel: () => null }));
vi.mock("../mmr/BuildMatchupHeatmap", () => ({ BuildMatchupHeatmap: () => null }));
vi.mock("../AllGamesTable", () => ({ AllGamesTable: () => <p>Fixture games table</p> }));
import { StrategiesTab } from "../StrategiesTab";
import { BuildVsStrategyView } from "../StrategiesTabBuildVs";
beforeEach(() => { localStorage.clear(); state.filters = {}; state.paths = []; state.options = []; state.noGames = false; state.previous = false; csv.download.mockClear(); });
afterEach(cleanup);
describe("strategy table and sheet", () => {
  it("uses radio keyboard controls, preserves the background and restores focus after Escape", () => {
    const { rerender } = render(<StrategiesTab />);
    const view = screen.getByRole("radiogroup", { name: /^Strategy view$/ });
    expect(within(view).getByRole("radio", { name: /Build vs strategy/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(within(view).getByRole("radio", { name: /Build vs strategy/ }), { key: "ArrowRight" });
    expect(within(view).getByRole("radio", { name: /By opponent strategy/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(within(view).getByRole("radio", { name: /By opponent strategy/ }), { key: "ArrowLeft" });
    const opener = screen.getByRole("button", { name: /^Z Build$/ }); opener.focus(); fireEvent.click(opener);
    expect(screen.getByRole("dialog", { name: /Z Build.*Z Strategy.*1 games/ })).toBeTruthy();
    expect(opener.isConnected).toBe(true);
    expect(screen.getByText(/Fixture games table/)).toBeTruthy();
    expect(state.paths.some(path => path?.startsWith("/v1/games-list") && path.includes("opp_race=P"))).toBe(true);
    state.filters = { map: "New map" }; state.previous = true;
    rerender(<StrategiesTab />);
    expect(screen.getByRole("dialog", { name: /Loading games/ })).toBeTruthy();
    expect(screen.queryByText(/Fixture games table/)).toBeNull();
    expect(state.options.at(-1)).toEqual({ keepPreviousData: false });
    state.previous = false; state.noGames = true;
    rerender(<StrategiesTab />);
    const modal = screen.getByRole("dialog", { name: /0 games/ });
    expect(within(modal).getByLabelText(/Active drill filters/).textContent).toContain("New map");
    expect(within(modal).getByText(/No games match this strategy/)).toBeTruthy();
    expect(state.paths.some(path => path?.startsWith("/v1/games-list") && path.includes("map=New+map") && path.includes("opp_race=P"))).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it("defaults from measured race volume, sorts heatmap axes and exports exactly searched cells", () => {
    render(<BuildVsStrategyView onOpenBvs={vi.fn()} initialView="heatmap" initialMinGames={1} onViewChange={vi.fn()} onMinGamesChange={vi.fn()} renderMinGamesPicker={() => null} />);
    expect(screen.getByRole("radio", { name: /versus Protoss/ }).getAttribute("aria-checked")).toBe("true");
    const table = screen.getByRole("table", { name: /heatmap/ });
    expect(within(table).getAllByRole("rowheader").map(node => node.textContent)).toEqual(["Z Build", "A Build"]);
    fireEvent.click(screen.getByRole("radio", { name: /A–Z/ }));
    expect(within(table).getAllByRole("rowheader").map(node => node.textContent)).toEqual(["A Build", "Z Build"]);
    const cell = within(table).getByRole("button", { name: /Z Build vs Z Strategy/ });
    expect(cell.style.opacity).toBe(""); expect(cell.style.color).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: /Search builds or strategies/ }), { target: { value: "Z Build" } });
    fireEvent.click(screen.getByRole("button", { name: /Export these rows as CSV/ }));
    const [filename, text] = csv.download.mock.calls[0];
    expect(filename).toMatch(/^sc2tools-build-vs-strategy-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(text).toContain("matrix matchup vs P"); expect(text).toContain("Z Build,Z Strategy"); expect(text).not.toContain("A Build,A Strategy"); expect(text).toContain("0.8");
  });
  it("hides the local race picker when global scope is set and never fans out races", () => {
    state.filters = { opp_race: "T" };
    render(<BuildVsStrategyView onOpenBvs={vi.fn()} initialView="heatmap" initialMinGames={1} onViewChange={vi.fn()} onMinGamesChange={vi.fn()} renderMinGamesPicker={() => null} />);
    expect(screen.queryByRole("radiogroup", { name: /Matrix matchup/ })).toBeNull();
    expect(state.paths.filter(Boolean).every(path => path!.includes("opp_race=T"))).toBe(true);
  });
});
