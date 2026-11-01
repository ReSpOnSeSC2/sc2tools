import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FiltersContext, type AnalyzerFilters } from "@/lib/filterContext";
import type { StrengthFields } from "@/lib/strengthAdjusted";

const harness = vi.hoisted(() => ({
  rows: [] as Array<StrengthFields & { name: string; total: number; wins: number; losses: number; winRate: number; checkins?: number }>,
  loaded: true, loading: false, error: null as Error | null,
  mutate: vi.fn(async () => undefined), paths: [] as string[],
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: vi.fn() }) }));
vi.mock("@/lib/clientApi", () => ({
  apiCall: vi.fn(),
  useApi: (path: string) => {
    harness.paths.push(path);
    if (!path.startsWith("/v1/builds")) throw new Error("Builds must use filtered replay analytics.");
    return { data: harness.loaded ? harness.rows : undefined, isLoading: harness.loading, error: harness.error, mutate: harness.mutate };
  },
}));
vi.mock("../BuildEditorModal", () => ({
  BuildEditorModal: ({ buildName, onClose }: { buildName: string; onClose: () => void }) =>
    <div role="dialog" aria-label={buildName}><button onClick={onClose}>Close dossier</button></div>,
}));
vi.mock("../mmr/BuildMmrPanel", () => ({ BuildMmrPanel: () => null }));
vi.mock("../mmr/BuildAgingCurve", () => ({ BuildAgingCurve: () => null }));
vi.mock("../mmr/MmrProgressionByBuild", () => ({ MmrProgressionByBuild: () => null }));
vi.mock("../charts/MixOverTimeChart", () => ({ MixOverTimeChart: () => null }));

import { BuildsTab } from "../BuildsTab";

function scopedTab(filters: AnalyzerFilters, dbRev = 3) {
  return <FiltersContext.Provider value={{ filters, dbRev, bumpRev: vi.fn(), setFilters: vi.fn(), seasons: [] }}>
    <BuildsTab />
  </FiltersContext.Provider>;
}

beforeEach(() => {
  localStorage.clear();
  harness.rows = [
    { name: "Custom gateway opener", total: 5, wins: 3, losses: 2, winRate: 0.6 },
    { name: "Standard opener", total: 8, wins: 6, losses: 2, winRate: 0.75 },
  ];
  harness.loaded = true; harness.loading = false; harness.error = null; harness.paths = [];
  harness.mutate.mockClear();
});
afterEach(cleanup);

describe("Builds tab filtered custom build integration", () => {
  it("sorts rated wins above expected and shows uncertainty without discarding partial coverage", () => {
    harness.rows = [
      { name: "Better adjusted", total: 7, wins: 5, losses: 2, winRate: 5/7, ratedGames: 4, ratedWins: 2, expectedWins: 1.5, winsAboveExpected: .5, excludedNoMmr: 3, winRateRange: { low: .36, high: .92 } },
      { name: "Higher raw rate", total: 10, wins: 9, losses: 1, winRate: .9, ratedGames: 10, ratedWins: 9, expectedWins: 9.5, winsAboveExpected: -.5 },
    ];
    render(<BuildsTab />); const table = within(screen.getByRole("table"));
    fireEvent.click(table.getByRole("button", { name: "Vs expected" }));
    expect(table.getAllByRole("row")[1].textContent).toContain("Better adjusted");
    expect(table.getByRole("img", { name: /2 rated wins − 1.50 expected wins/ }).title).toContain("3 missing paired ratings");
    expect(table.getByRole("img", { name: /95% Wilson range 36.0 to 92.0/ })).toBeTruthy();
    fireEvent.click(table.getByRole("button", { name: "Vs expected" })); expect(table.getAllByRole("row")[1].textContent).toContain("Higher raw rate");
  });

  it("ranks custom and detected builds in one table with the same dossier action", () => {
    render(<BuildsTab />);
    const table = within(screen.getByRole("table"));
    const rows = table.getAllByRole("row").slice(1);
    expect(rows.map((row) => row.querySelector("td")?.textContent)).toEqual(["Standard opener", "Custom gateway opener"]);
    const custom = table.getByRole("row", { name: /Custom gateway opener/ });
    expect(within(custom).getAllByRole("cell").slice(1, 4).map((cell) => cell.textContent)).toEqual(["3", "2", "5"]);
    expect(screen.queryByRole("region", { name: "Your custom builds" })).toBeNull();
    fireEvent.click(custom);
    expect(screen.getByRole("dialog", { name: "Custom gateway opener" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close dossier" }));
    fireEvent.click(table.getByRole("row", { name: /Standard opener/ }));
    expect(screen.getByRole("dialog", { name: "Standard opener" })).toBeTruthy();
  });

  it("notes games that count only through a build check-in", () => {
    harness.rows[0] = { ...harness.rows[0], checkins: 2 };
    render(<BuildsTab />);
    const custom = within(screen.getByRole("table")).getByRole("row", { name: /Custom gateway opener/ });
    expect(within(custom).getByText("incl. 2 check-ins")).toBeTruthy();
    // The mobile card list carries the same note; rows without check-ins stay quiet.
    expect(screen.getAllByText("incl. 2 check-ins")).toHaveLength(2);
    const standard = within(screen.getByRole("table")).getByRole("row", { name: /Standard opener/ });
    expect(within(standard).queryByText(/check-in/)).toBeNull();
  });

  it("explains WR, W/L split and counted check-ins without opening the build", async () => {
    harness.rows[0] = { ...harness.rows[0], checkins: 2 };
    render(<BuildsTab />);
    const table = within(screen.getByRole("table"));
    // Header names stay exact; each help control is its own button.
    expect(table.getByRole("columnheader", { name: "WR" })).toBeTruthy();
    // jsdom leaves a header button's name out either way; browsers may not, so the cell names itself.
    expect(table.getByRole("columnheader", { name: "W/L split" }).getAttribute("aria-label")).toBe("W/L split");
    for (const [name, term] of [["About WR", "build-stats-win-rate"], ["About W/L split", "build-record"]]) {
      fireEvent.click(table.getByRole("button", { name }));
      const opened = await screen.findByRole("dialog", { name });
      expect((await within(opened).findByRole("link", { name: "Learn more" })).getAttribute("href")).toBe(`/help/glossary#${term}`);
      fireEvent.keyDown(opened, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());
    }
    const custom = table.getByRole("row", { name: /Custom gateway opener/ });
    expect(within(custom).getByText("incl. 2 check-ins").closest("[title]")).toBeNull();
    fireEvent.click(within(custom).getByRole("button", { name: "About Counted check-ins" }));
    const tip = await screen.findByRole("dialog", { name: "About Counted check-ins" });
    fireEvent.click(await within(tip).findByText("Games assigned here only because a check-in changed their detected build identity."));
    expect(screen.queryByRole("dialog", { name: "Custom gateway opener" })).toBeNull();
    // The note's own text is part of the row and still opens the build.
    fireEvent.click(within(custom).getByText("incl. 2 check-ins"));
    expect(screen.getByRole("dialog", { name: "Custom gateway opener" })).toBeTruthy();
  });

  it("applies search, minimum games and sorting equally to both build types", () => {
    harness.rows.push(
      { name: "Custom rare opener", total: 1, wins: 1, losses: 0, winRate: 1 },
      { name: "Standard rare opener", total: 1, wins: 1, losses: 0, winRate: 1 },
    );
    render(<BuildsTab />);
    fireEvent.click(screen.getByRole("radio", { name: "3" }));
    expect(screen.queryByText("Custom rare opener")).toBeNull();
    expect(screen.queryByText("Standard rare opener")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search builds"), { target: { value: "custom" } });
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
    expect(screen.queryByText("Standard opener")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search builds"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /Games/ }));
    expect(within(screen.getByRole("table")).getAllByRole("row").slice(1).map((row) => row.querySelector("td")?.textContent))
      .toEqual(["Custom gateway opener", "Standard opener"]);
  });

  it("removes both types when the selected replay filters have no matching games", () => {
    const filters: AnalyzerFilters = {
      since: "2026-09-01", until: "2026-09-21", race: "P", opp_race: "T", regions: "NA",
      map: "Site Delta", map_pool: "ladder", game_size: "1v1", mmr_min: 4000, mmr_max: 6000,
      min_minutes: 6, max_minutes: 15,
    };
    const { rerender } = render(scopedTab(filters));
    expect(screen.getByRole("table")).toBeTruthy();
    const request = new URL(harness.paths.at(-1)!, "https://example.test");
    for (const [key, value] of Object.entries(filters)) expect(request.searchParams.get(key)).toBe(String(value));
    expect(request.hash).toBe("#3");
    harness.rows = [];
    rerender(scopedTab({ ...filters, regions: "EU" }, 4));
    expect(screen.getByText("No builds match these filters")).toBeTruthy();
    expect(screen.queryByText("Custom gateway opener")).toBeNull();
    expect(screen.queryByText("Standard opener")).toBeNull();
    expect(harness.paths.at(-1)).toContain("regions=EU");
    expect(harness.paths.at(-1)).toMatch(/#4$/);
  });

  it("does not display zero-game definitions or fetch an unfiltered library", () => {
    harness.rows = [{ name: "Unplayed saved build", total: 0, wins: 0, losses: 0, winRate: 0 }];
    render(<BuildsTab />);
    expect(screen.getByText("No builds match these filters")).toBeTruthy();
    expect(screen.queryByText("Unplayed saved build")).toBeNull();
    expect(harness.paths.every((path) => path.startsWith("/v1/builds"))).toBe(true);
  });

  it("honors the persisted minimum-game threshold for every build", () => {
    localStorage.setItem("analyzer.builds.minGames", "20");
    render(<BuildsTab />);
    expect(screen.getByText("No builds match these filters")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lower Min games to 1 (2 hidden by Min games)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "1" }));
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3);
  });

  it("waits for matching replay results without displaying saved definitions", () => {
    harness.loaded = false; harness.loading = true;
    render(<BuildsTab />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("No builds match these filters")).toBeNull();
    expect(screen.queryByText("Custom gateway opener")).toBeNull();
  });

  it("reports a failed query and supports retry without claiming no matching games", () => {
    harness.loaded = false; harness.error = new Error("Unavailable");
    render(<BuildsTab />);
    expect(screen.getByTestId("request-error").textContent).toContain("Your filters are still applied.");
    expect(screen.queryByText("No builds match these filters")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.mutate).toHaveBeenCalledOnce();
  });

  it("identifies stale results when refreshing the same filters fails", () => {
    harness.error = new Error("Unavailable");
    render(<BuildsTab />);
    expect(screen.getByRole("alert").textContent).toContain("last loaded results for these filters");
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3);
  });
});
