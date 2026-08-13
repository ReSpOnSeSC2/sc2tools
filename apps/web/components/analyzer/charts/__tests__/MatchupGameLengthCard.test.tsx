import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
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

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
  useFiltersMock.mockReset();
});

describe("MatchupGameLengthCard", () => {
  it("forwards global filters/dbRev and renders only real dynamic matchups", () => {
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
    useApiMock.mockReturnValue({
      isLoading: false,
      data: {
        summary: {
          games: 7,
          avgSec: 720,
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
            avgSec: 600,
            medianSec: 570,
            avgWinSec: 540,
            avgLossSec: 660,
            longGameRate: 0.25,
          },
          // Invalid rows never become UI placeholders.
          {
            matchup: "PvZ",
            myRace: "P",
            opponentRace: "Z",
            games: 0,
            avgSec: null,
          },
        ],
      },
    });

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
    expect(screen.getAllByText("25%")).toHaveLength(2);

    const matchupHeadings = screen.getAllByRole("heading", { level: 4 });
    expect(matchupHeadings.map((heading) => heading.textContent)).toEqual([
      "PvT",
      "TvZ",
    ]);
    expect(screen.queryByText("PvZ")).toBeNull();

    const pvt = matchupHeadings[0].closest("li");
    expect(pvt).not.toBeNull();
    const pvtView = within(pvt!);
    expect(pvtView.getByText("4 games")).toBeTruthy();
    expect(pvtView.getByText("10:00")).toBeTruthy();
    expect(pvtView.getByText("9:30")).toBeTruthy();
    expect(pvtView.getByText("9:00")).toBeTruthy();
    expect(pvtView.getByText("11:00")).toBeTruthy();
    expect(pvtView.getByText("Wins · 3")).toBeTruthy();
    expect(pvtView.getByText("Losses · 1")).toBeTruthy();
  });

  it("shows an honest empty state without inventing matchup rows", () => {
    useFiltersMock.mockReturnValue({ filters: { race: "Z" }, dbRev: 2 });
    useApiMock.mockReturnValue({
      isLoading: false,
      data: {
        summary: {
          games: 0,
          avgSec: null,
          medianSec: null,
          longGameRate: 0,
        },
        matchups: [],
      },
    });

    render(<MatchupGameLengthCard />);

    expect(screen.getByText("No game-length data in this view")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 4 })).toBeNull();
    expect(String(useApiMock.mock.calls[0]?.[0])).toBe(
      "/v1/length-buckets?race=Z#2",
    );
  });
});
