import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MatchupGameLengthCard } from "../MatchupGameLengthCard";

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

const populatedData = {
  summary: {
    games: 7,
    totalSec: 5_100,
    avgSec: 729,
    medianSec: 660,
    longGameRate: 0.25,
  },
  // Deliberately unsorted: the component uses canonical race order.
  matchups: [
    {
      matchup: "TvZ",
      myRace: "T",
      opponentRace: "Z",
      games: 3,
      wins: 1,
      losses: 2,
      totalSec: 2_700,
      avgSec: 900,
      medianSec: 840,
      avgWinSec: 780,
      avgLossSec: 960,
      longGameRate: 2 / 3,
    },
    {
      matchup: "PvT",
      myRace: "P",
      opponentRace: "T",
      games: 4,
      wins: 3,
      losses: 1,
      totalSec: 2_400,
      avgSec: 600,
      medianSec: 570,
      avgWinSec: 540,
      avgLossSec: 660,
      longGameRate: 0.25,
    },
    // Invalid rows never become UI placeholders or contribute playtime.
    {
      matchup: "PvZ",
      myRace: "P",
      opponentRace: "Z",
      games: 0,
      totalSec: null,
      avgSec: null,
    },
  ],
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  useApiMock.mockReset();
  useFiltersMock.mockReset();
});

function mockPopulatedCard() {
  useFiltersMock.mockReturnValue({
    filters: {
      since: "2026-07-01T00:00:00.000Z",
      race: "P",
      opp_race: "T",
      map_pool: "ladder",
      game_size: "1v1",
    },
    dbRev: 11,
  });
  useApiMock.mockReturnValue({ isLoading: false, data: populatedData });
}

function matchupRow(name: string): HTMLElement {
  const row = screen
    .getByRole("heading", { level: 4, name })
    .closest("li");
  if (!row) throw new Error(`Missing matchup row for ${name}`);
  return row;
}

function metricValue(root: HTMLElement, label: string): string | null {
  const term = within(root).getByText(label);
  return term.parentElement?.querySelector("dd")?.textContent ?? null;
}

describe("MatchupGameLengthCard", () => {
  it("forwards global filters/dbRev and renders default total playtime for every real matchup", () => {
    mockPopulatedCard();

    render(<MatchupGameLengthCard />);

    const request = String(useApiMock.mock.calls[0]?.[0]);
    expect(request).toContain("/v1/length-buckets?");
    expect(request).toContain("since=2026-07-01T00%3A00%3A00.000Z");
    expect(request).toContain("race=P");
    expect(request).toContain("opp_race=T");
    expect(request).toContain("map_pool=ladder");
    expect(request).toContain("game_size=1v1");
    expect(request).toContain("#11");

    expect(screen.getByText("7 measured games")).toBeTruthy();
    expect(metricValue(document.body, "Total played")).toBe("1h 25m");
    expect(screen.getAllByText("25%")).toHaveLength(2);

    const matchupHeadings = screen.getAllByRole("heading", { level: 4 });
    expect(matchupHeadings.map((heading) => heading.textContent)).toEqual([
      "PvT",
      "TvZ",
    ]);
    expect(screen.queryByText("PvZ")).toBeNull();

    const pvt = matchupRow("PvT");
    const pvtView = within(pvt);
    expect(pvtView.getByText("4 games")).toBeTruthy();
    expect(metricValue(pvt, "Time played")).toBe("0h 40m");
    expect(pvtView.getByText("10:00")).toBeTruthy();
    expect(pvtView.getByText("9:30")).toBeTruthy();
    expect(pvtView.getByText("9:00")).toBeTruthy();
    expect(pvtView.getByText("11:00")).toBeTruthy();
    expect(metricValue(matchupRow("TvZ"), "Time played")).toBe("0h 45m");

    // The summary and matchup grids reflow instead of scrolling sideways.
    const summaryGrid = screen.getByText("Total played").closest("dl");
    expect(summaryGrid?.className).toContain("grid-cols-2");
    expect(summaryGrid?.className).toContain("sm:grid-cols-4");
    const matchupGrid = screen.getByRole("list");
    expect(matchupGrid.className).toContain("grid-cols-1");
    expect(matchupGrid.className).toContain("sm:grid-cols-2");
    expect(matchupGrid.className).toContain("xl:grid-cols-3");
    expect(pvtView.getByText("Wins · 3")).toBeTruthy();
    expect(pvtView.getByText("Losses · 1")).toBeTruthy();
  });

  it("offers an accessible five-option time format and updates the overall and every matchup total", () => {
    mockPopulatedCard();
    render(<MatchupGameLengthCard />);

    const format = screen.getByRole("combobox", {
      name: "Time format",
    }) as HTMLSelectElement;
    expect(format.value).toBe("hoursMinutes");
    expect(
      within(format)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "Weeks",
      "Days",
      "Hours",
      "Hours and minutes",
      "Minutes and seconds",
    ]);

    const cases = [
      {
        value: "weeks",
        overall: "<0.01 weeks",
        pvt: "<0.01 weeks",
        tvz: "<0.01 weeks",
      },
      {
        value: "days",
        overall: "0.06 days",
        pvt: "0.03 days",
        tvz: "0.03 days",
      },
      {
        value: "hours",
        overall: "1.42 hours",
        pvt: "0.67 hours",
        tvz: "0.75 hours",
      },
      {
        value: "hoursMinutes",
        overall: "1h 25m",
        pvt: "0h 40m",
        tvz: "0h 45m",
      },
      {
        value: "minutesSeconds",
        overall: "85m 0s",
        pvt: "40m 0s",
        tvz: "45m 0s",
      },
    ];

    for (const expected of cases) {
      fireEvent.change(format, { target: { value: expected.value } });
      expect(format.value).toBe(expected.value);
      expect(metricValue(document.body, "Total played")).toBe(
        expected.overall,
      );
      expect(metricValue(matchupRow("PvT"), "Time played")).toBe(
        expected.pvt,
      );
      expect(metricValue(matchupRow("TvZ"), "Time played")).toBe(
        expected.tvz,
      );
    }
  });

  it("restores and persists the time format without changing the server-safe default", async () => {
    window.localStorage.setItem(
      "analyzer.trends.playtimeFormat",
      "minutesSeconds",
    );
    mockPopulatedCard();

    render(<MatchupGameLengthCard />);

    const format = screen.getByRole("combobox", {
      name: "Time format",
    }) as HTMLSelectElement;
    await waitFor(() => expect(format.value).toBe("minutesSeconds"));
    expect(metricValue(document.body, "Total played")).toBe("85m 0s");

    fireEvent.change(format, { target: { value: "days" } });
    expect(window.localStorage.getItem("analyzer.trends.playtimeFormat")).toBe(
      "days",
    );
  });

  it("shows the full empty state only when no measured duration exists", () => {
    useFiltersMock.mockReturnValue({ filters: { race: "Z" }, dbRev: 2 });
    useApiMock.mockReturnValue({
      isLoading: false,
      data: {
        summary: {
          games: 0,
          totalSec: null,
          avgSec: null,
          medianSec: null,
          longGameRate: 0,
        },
        matchups: [],
      },
    });

    render(<MatchupGameLengthCard />);

    expect(screen.getByText("No game-length data in this view")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Time format" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 4 })).toBeNull();
    expect(String(useApiMock.mock.calls[0]?.[0])).toBe(
      "/v1/length-buckets?race=Z#2",
    );
  });

  it("renders a loading skeleton without flashing either empty state", () => {
    useFiltersMock.mockReturnValue({ filters: {}, dbRev: 3 });
    useApiMock.mockReturnValue({ isLoading: true, data: undefined });

    const { container } = render(<MatchupGameLengthCard />);

    expect(screen.getByText("Time played by matchup")).toBeTruthy();
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(3);
    expect(screen.queryByText("No game-length data in this view")).toBeNull();
    expect(screen.queryByText("No matchup breakdown for this view")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Time format" })).toBeNull();
  });

  it("keeps the real overall total visible when missing race metadata prevents a matchup breakdown", () => {
    useFiltersMock.mockReturnValue({
      filters: { map_pool: "ladder" },
      dbRev: 4,
    });
    useApiMock.mockReturnValue({
      isLoading: false,
      data: {
        summary: {
          games: 2,
          totalSec: 1_800,
          avgSec: 900,
          medianSec: 900,
          longGameRate: 0.5,
        },
        matchups: [],
      },
    });

    render(<MatchupGameLengthCard />);

    expect(screen.getByText("2 measured games")).toBeTruthy();
    expect(metricValue(document.body, "Total played")).toBe("0h 30m");
    expect(screen.getByText("No matchup breakdown for this view")).toBeTruthy();
    expect(
      screen.getByText(/do not have both races needed to form a matchup/i),
    ).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Time format" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 4 })).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });
});
