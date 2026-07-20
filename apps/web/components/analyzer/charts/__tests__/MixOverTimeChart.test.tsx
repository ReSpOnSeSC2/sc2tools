import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MixOverTimeChart } from "../MixOverTimeChart";

const useApiMock = vi.fn();
const useFiltersMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

vi.mock("@/lib/filterContext", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/filterContext")>();
  return {
    ...actual,
    useFilters: () => useFiltersMock(),
  };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ||
  ResizeObserverStub;

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
  useFiltersMock.mockReset();
});

const BASE_PROPS = {
  endpoint: "timeseries/my-builds",
  title: "Your build mix over time",
  caption: "Build mix.",
  bucket: "week" as const,
};

describe("MixOverTimeChart matchup filter", () => {
  it("requests and labels the selected opponent matchup", () => {
    useFiltersMock.mockReturnValue({
      filters: { race: "P", since: "2026-07-01T00:00:00.000Z" },
      dbRev: 7,
    });
    useApiMock.mockReturnValue({
      data: {
        interval: "week",
        points: [
          {
            bucket: "2026-07-12T00:00:00.000Z",
            key: "PvZ - Stargate into Glaives",
            wins: 2,
            losses: 1,
            total: 3,
          },
        ],
      },
      isLoading: false,
    });
    const onChange = vi.fn();

    render(
      <MixOverTimeChart
        {...BASE_PROPS}
        matchupFilter={{ opponentRace: "Z", onChange }}
      />,
    );

    const matchup = screen.getByRole("combobox", {
      name: "Your build mix over time matchup",
    }) as HTMLSelectElement;
    expect(matchup.value).toBe("Z");
    expect(
      within(matchup)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["All matchups", "PvP", "PvT", "PvZ"]);

    const request = String(useApiMock.mock.calls[0]?.[0]);
    expect(request).toContain("/v1/timeseries/my-builds?");
    expect(request).toContain("race=P");
    expect(request).toContain("opp_race=Z");
    expect(request).toContain("interval=week");
    expect(request).toContain("#7");

    fireEvent.change(matchup, { target: { value: "T" } });
    expect(onChange).toHaveBeenCalledWith("T");
  });

  it("keeps the matchup selector available when that scope has no games", () => {
    useFiltersMock.mockReturnValue({ filters: {}, dbRev: 0 });
    useApiMock.mockReturnValue({
      data: { interval: "week", points: [] },
      isLoading: false,
    });

    render(
      <MixOverTimeChart
        {...BASE_PROPS}
        emptyTitle="No build mix yet"
        matchupFilter={{ opponentRace: "T", onChange: vi.fn() }}
      />,
    );

    expect(screen.getByText("No build mix yet")).toBeTruthy();
    const matchup = screen.getByRole("combobox", {
      name: "Your build mix over time matchup",
    });
    expect(
      within(matchup)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "All matchups",
      "vs Protoss",
      "vs Terran",
      "vs Zerg",
    ]);
  });

  it("lets All matchups clear a global opponent-race constraint for these cards", () => {
    useFiltersMock.mockReturnValue({
      filters: { opp_race: "P" },
      dbRev: 0,
    });
    useApiMock.mockReturnValue({
      data: { interval: "week", points: [] },
      isLoading: false,
    });

    render(
      <MixOverTimeChart
        {...BASE_PROPS}
        matchupFilter={{ opponentRace: "", onChange: vi.fn() }}
      />,
    );

    const request = String(useApiMock.mock.calls[0]?.[0]);
    expect(request).not.toContain("opp_race=");
  });
});

function mixPoint(
  bucket: string,
  key: string,
  wins: number,
  losses: number,
) {
  return { bucket, key, wins, losses, total: wins + losses };
}

describe("MixOverTimeChart cadence matrix", () => {
  it("renders a labelled row per build, folds extras into Other, and shows counts", () => {
    useFiltersMock.mockReturnValue({ filters: {}, dbRev: 0 });
    const week1 = "2026-07-05T00:00:00.000Z";
    const week2 = "2026-07-12T00:00:00.000Z";
    // 7 distinct keys with default topN=6 → the least-played key
    // ("Build G") must fold into an "Other" row.
    const points = [
      mixPoint(week1, "Build A", 3, 1),
      mixPoint(week1, "Build B", 2, 1),
      mixPoint(week1, "Build C", 2, 0),
      mixPoint(week2, "Build A", 1, 1),
      mixPoint(week2, "Build D", 1, 1),
      mixPoint(week2, "Build E", 1, 0),
      mixPoint(week2, "Build F", 1, 0),
      mixPoint(week2, "Build G", 0, 1),
    ];
    useApiMock.mockReturnValue({
      data: { interval: "week", points },
      isLoading: false,
    });

    render(<MixOverTimeChart {...BASE_PROPS} />);

    for (const label of [
      "Build A",
      "Build B",
      "Build C",
      "Build D",
      "Build E",
      "Build F",
      "Other",
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    // Cell titles carry the honest per-period record.
    expect(
      screen.getByTitle("Build A · 2026-07-05 · 4 games · 3W-1L"),
    ).toBeTruthy();
    expect(
      screen.getByTitle("Other · 2026-07-12 · 1 game · 0W-1L"),
    ).toBeTruthy();
  });

  it("defaults the breakdown to the latest period and pins a clicked column", () => {
    useFiltersMock.mockReturnValue({ filters: {}, dbRev: 0 });
    useApiMock.mockReturnValue({
      data: {
        interval: "week",
        points: [
          mixPoint("2026-07-05T00:00:00.000Z", "Build A", 2, 1),
          mixPoint("2026-07-12T00:00:00.000Z", "Build B", 1, 0),
        ],
      },
      isLoading: false,
    });

    render(<MixOverTimeChart {...BASE_PROPS} />);

    expect(screen.getByText("2026-07-12")).toBeTruthy();
    expect(screen.getByText("Latest period")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Show 2026-07-05 breakdown" }),
    );
    expect(screen.getByText("2026-07-05")).toBeTruthy();
    expect(screen.getByText("Selected")).toBeTruthy();
    expect(screen.getAllByText("3 games").length).toBeGreaterThan(0);
  });

  it("keeps calendar gaps visible as empty columns", () => {
    useFiltersMock.mockReturnValue({ filters: {}, dbRev: 0 });
    useApiMock.mockReturnValue({
      data: {
        interval: "day",
        points: [
          mixPoint("2026-07-01T00:00:00.000Z", "Build A", 1, 0),
          mixPoint("2026-07-04T00:00:00.000Z", "Build A", 0, 1),
        ],
      },
      isLoading: false,
    });

    render(<MixOverTimeChart {...BASE_PROPS} bucket="day" />);

    // The two idle days between the played days become real columns.
    expect(
      screen.getByRole("button", { name: "Show 2026-07-02 breakdown" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Show 2026-07-03 breakdown" }),
    ).toBeTruthy();
    expect(screen.getByTitle("Build A · 2026-07-02 · no games")).toBeTruthy();
  });
});
