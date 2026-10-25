import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MapVetoPlanner } from "./MapVetoPlanner";
import { POOL_MAX_AGE_MS } from "@/lib/currentMapPool";

const state = vi.hoisted(() => ({ now: Date.now(), filters: { race: "P", opp_race: "T", since: "2026-10-01" } as Record<string, string>, source: "persisted" as "persisted" | "fallback", age: 0, error: false, stale: false, paths: [] as (string | null)[], copied: vi.fn(), retry: vi.fn() }));
const CELLS = [{ map: "Alpha LE", matchup: "vs Z", wins: 1, losses: 9, total: 10 }, { map: "Beta", matchup: "vs Z", wins: 9, losses: 1, total: 10 }, { map: "Tiny", matchup: "vs Z", wins: 0, losses: 4, total: 10 }];
const csvExport = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock("@/lib/csvExport", async original => ({ ...(await original<typeof import("@/lib/csvExport")>()), downloadCsv: csvExport.download }));
vi.mock("@/lib/filterContext", async (original) => ({ ...(await original<typeof import("@/lib/filterContext")>()), useFilters: () => ({ filters: state.filters, dbRev: 7, seasons: [{ isCurrent: true, start: "2026-09-15" }] }) }));
vi.mock("@/lib/useSeasons", () => ({ useSeasons: () => ({ data: { mapPool: ["Alpha", "Beta", "Tiny"], mapPoolSource: state.source, mapPoolFetchedAt: state.now - state.age }, mutate: vi.fn() }) }));
vi.mock("@/lib/useGuideMapPool", () => ({ useGuideMapPool: () => ({ data: { computedAt: "2026-10-20", era: "after", maps: [{ map: "Alpha", cells: [{ matchup: "PvZ", winRate: 0.55 }] }] } }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string | null) => { state.paths.push(path); return { data: path?.startsWith("/v1/maps/matchups") ? CELLS : path?.startsWith("/v1/maps?") ? [{ name: "Alpha LE", recent: ["loss", "win"] }] : undefined, error: state.error && path?.includes("matchups") ? new Error("Synthetic outage") : undefined, isPreviousData: state.stale, mutate: state.retry }; } }));
vi.mock("@/components/maps/MapArtwork", () => ({ MapLabel: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: () => <span>Help</span> }));

beforeEach(() => { state.now = Date.now(); state.age = 0; state.source = "persisted"; state.error = false; state.stale = false; state.filters = { race: "P", opp_race: "T", since: "2026-10-01" }; state.paths = []; state.copied.mockReset(); state.copied.mockResolvedValue(undefined); state.retry.mockReset(); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: state.copied } }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("map veto planner", () => {
  it("exports the twelve displayed pool cells, local ranking and window without extra reads", () => {
    csvExport.download.mockReset(); render(<MapVetoPlanner openGames={vi.fn()} />);
    const requests = state.paths.length;
    fireEvent.click(screen.getByRole("button", { name: /Export these rows as CSV/ }));
    const [filename, csv] = csvExport.download.mock.calls[0];
    expect(filename).toMatch(/^sc2tools-map-pool-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csv).toContain("ranking vs Z"); expect(csv).toContain("window filters");
    expect(csv.split("\r\n").filter((line: string) => /^(Alpha|Beta|Tiny),/.test(line))).toHaveLength(12);
    expect(csv).toContain("Alpha,vs Z,1,9,10,10,0.1,0.55,true");
    expect(state.paths.length).toBe(requests);
  });
  it("expires suggestions on a long-open page while preserving the selected 90-day sample anchor", () => {
    vi.useFakeTimers(); vi.setSystemTime(state.now); state.age = POOL_MAX_AGE_MS - 30_000;
    render(<MapVetoPlanner openGames={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Sample window" }), { target: { value: "90d" } });
    const sample = state.paths.filter((path) => path?.includes("/maps/matchups")).at(-1);
    expect(screen.getByText("Suggested veto")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.queryByText("Suggested veto")).toBeNull();
    expect((screen.getByRole("button", { name: "Copy veto list" }) as HTMLButtonElement).disabled).toBe(true);
    expect(state.paths.filter((path) => path?.includes("/maps/matchups")).at(-1)).toBe(sample);
  });

  it("uses a bounded shared sample, real rankings, community side, copy and cell drilldowns", async () => {
    const open = vi.fn(); render(<MapVetoPlanner openGames={open} />);
    expect((screen.getByRole("combobox", { name: "Ranking matchup" }) as HTMLSelectElement).value).toBe("Z");
    expect(screen.getAllByText("Suggested veto")).toHaveLength(1);
    expect(screen.getByText("Not enough games")).toBeTruthy();
    const alpha = screen.getByRole("button", { name: "View games on Alpha" }).closest("tr")!;
    expect(within(alpha).getByText("Suggested veto")).toBeTruthy(); expect(within(alpha).getByText(/Community 55/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View vs Z games on Alpha" }));
    expect(open).toHaveBeenCalledWith({ map: "Alpha LE", maps: ["Alpha LE"], opponent: "Z", filters: { race: "P", opp_race: undefined, since: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy veto list" })); await waitFor(() => expect(state.copied).toHaveBeenCalledWith("Suggested SC2 vetoes vs Z: Alpha"));
    expect(new Set(state.paths.filter((path) => path?.startsWith("/v1/maps/matchups"))).size).toBe(1);
    expect(state.paths.some((path) => path?.includes("/games"))).toBe(false);
  });
  it("switches date windows and count without per-map requests or vetoing the low sample", () => {
    render(<MapVetoPlanner openGames={vi.fn()} />); fireEvent.change(screen.getByRole("combobox", { name: "Veto count" }), { target: { value: "3" } });
    expect(screen.getAllByText("Suggested veto")).toHaveLength(2);
    fireEvent.change(screen.getByRole("combobox", { name: "Sample window" }), { target: { value: "90d" } });
    expect(state.paths.filter((path) => path?.includes("/maps/matchups")).at(-1)).toContain(encodeURIComponent(new Date(state.now - 90 * 86400_000).toISOString()).slice(0, 10));
    fireEvent.change(screen.getByRole("combobox", { name: "Sample window" }), { target: { value: "season" } });
    expect(state.paths.filter((path) => path?.includes("/maps/matchups")).at(-1)).toContain("since=2026-09-15");
  });
  it.each(["fallback", "old", "error", "previous"])("suppresses suggestions for %s data", (mode) => {
    state.source = mode === "fallback" ? "fallback" : "persisted"; state.age = mode === "old" ? 9 * 86400_000 : 0; state.error = mode === "error"; state.stale = mode === "previous";
    render(<MapVetoPlanner openGames={vi.fn()} />); expect(screen.queryByText("Suggested veto")).toBeNull(); expect((screen.getByRole("button", { name: "Copy veto list" }) as HTMLButtonElement).disabled).toBe(true);
    if (mode === "error") { fireEvent.click(screen.getByRole("button", { name: "Retry sample" })); expect(state.retry).toHaveBeenCalledOnce(); }
  });
  it("provides a selectable clipboard fallback", async () => {
    state.copied.mockRejectedValue(new Error("Clipboard unavailable")); render(<MapVetoPlanner openGames={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy veto list" })); expect(await screen.findByRole("textbox", { name: "Copy this veto list" })).toBeTruthy();
  });
});
