import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  formatDailySwingDate,
  MmrDailySwings,
} from "../MmrDailySwings";

afterEach(cleanup);

describe("MmrDailySwings", () => {
  it("keeps the compact overall fallback for cached responses without regions", () => {
    render(
      <MmrDailySwings
        dailySwings={{
          timezone: "America/New_York",
          measuredDays: 5,
          measuredGames: 12,
          bestGain: {
            day: "2026-08-10T04:00:00.000Z",
            netMmr: 86,
            measuredGames: 4,
            wins: 3,
            losses: 1,
          },
          biggestLoss: {
            day: "2026-08-12T04:00:00.000Z",
            netMmr: -51,
            measuredGames: 3,
            wins: 1,
            losses: 2,
          },
        }}
      />,
    );

    expect(screen.getByRole("region", { name: "Daily MMR records" })).toBeTruthy();
    expect(screen.getByText("Highest MMR gain day")).toBeTruthy();
    expect(screen.getByText("+86 MMR")).toBeTruthy();
    expect(screen.getByText("Biggest MMR loss day")).toBeTruthy();
    expect(screen.getByText("−51 MMR")).toBeTruthy();
    expect(screen.getByText(/12 measured games across 5 days/)).toBeTruthy();
    expect(screen.getByText("Aug 10, 2026")).toBeTruthy();
    expect(screen.getByText("4 measured games")).toBeTruthy();
    expect(screen.getByText("3 wins, 1 loss")).toBeTruthy();
  });

  it("keeps NA and EU records distinct without showing a combined extreme", () => {
    render(
      <MmrDailySwings
        dailySwings={{
          timezone: "America/New_York",
          measuredDays: 6,
          measuredGames: 14,
          // Compatibility aggregate must not masquerade as one ladder region.
          bestGain: {
            day: "2026-08-13T04:00:00.000Z",
            netMmr: 999,
            measuredGames: 5,
            wins: 5,
            losses: 0,
          },
          biggestLoss: {
            day: "2026-08-09T04:00:00.000Z",
            netMmr: -999,
            measuredGames: 5,
            wins: 0,
            losses: 5,
          },
          regions: [
            {
              region: "NA",
              measuredDays: 4,
              measuredGames: 9,
              bestGain: {
                day: "2026-08-10T04:00:00.000Z",
                netMmr: 48,
                measuredGames: 3,
                wins: 2,
                losses: 1,
              },
              biggestLoss: {
                day: "2026-08-11T04:00:00.000Z",
                netMmr: -20,
                measuredGames: 2,
                wins: 1,
                losses: 1,
              },
            },
            {
              region: "EU",
              measuredDays: 2,
              measuredGames: 5,
              bestGain: {
                day: "2026-08-12T04:00:00.000Z",
                netMmr: 61,
                measuredGames: 2,
                wins: 2,
                losses: 0,
              },
              biggestLoss: null,
            },
          ],
        }}
      />,
    );

    const breakdown = screen.getByLabelText(
      "MMR records by your Battle.net region",
    );
    const na = within(breakdown).getByRole("article", {
      name: "NA daily MMR records",
    });
    const eu = within(breakdown).getByRole("article", {
      name: "EU daily MMR records",
    });

    expect(within(na).getByText("+48 MMR")).toBeTruthy();
    expect(within(na).getByText("−20 MMR")).toBeTruthy();
    expect(within(eu).getByText("+61 MMR")).toBeTruthy();
    expect(within(eu).getByText("No measured loss")).toBeTruthy();
    expect(screen.queryByText("+999 MMR")).toBeNull();
    expect(screen.queryByText("−999 MMR")).toBeNull();
    // Gain/loss stay side-by-side in each narrow, self-contained region row.
    expect(na.querySelector(".grid-cols-2")).toBeTruthy();
    expect(eu.querySelector(".grid-cols-2")).toBeTruthy();
    expect(
      screen.getByText(/opponent-region and all other selected filters still apply/),
    ).toBeTruthy();
  });

  it("labels unknown own-region data instead of dropping it", () => {
    render(
      <MmrDailySwings
        dailySwings={{
          timezone: "UTC",
          measuredDays: 2,
          measuredGames: 2,
          bestGain: null,
          biggestLoss: null,
          regions: [
            {
              region: "NA",
              measuredDays: 1,
              measuredGames: 1,
              bestGain: null,
              biggestLoss: null,
            },
            {
              region: "U",
              measuredDays: 1,
              measuredGames: 1,
              bestGain: null,
              biggestLoss: null,
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByRole("article", { name: "Unknown region daily MMR records" }),
    ).toBeTruthy();
  });

  it("renders a gain even when the filtered range has no loss day", () => {
    render(
      <MmrDailySwings
        dailySwings={{
          timezone: "UTC",
          measuredDays: 1,
          measuredGames: 2,
          bestGain: {
            day: "2026-08-13T00:00:00.000Z",
            netMmr: 31,
            measuredGames: 2,
            wins: 2,
            losses: 0,
          },
          biggestLoss: null,
        }}
      />,
    );

    expect(screen.getByText("+31 MMR")).toBeTruthy();
    expect(screen.getByText("No measured loss")).toBeTruthy();
    expect(screen.queryByText("No measured gain")).toBeNull();
  });

  it("states no-gain and no-loss semantics independently for flat days", () => {
    render(
      <MmrDailySwings
        dailySwings={{
          timezone: "UTC",
          measuredDays: 2,
          measuredGames: 4,
          bestGain: null,
          biggestLoss: null,
        }}
      />,
    );

    expect(screen.getByText("No measured gain")).toBeTruthy();
    expect(screen.getByText("No day finished above 0 MMR in this view.")).toBeTruthy();
    expect(screen.getByText("No measured loss")).toBeTruthy();
    expect(screen.getByText("No day finished below 0 MMR in this view.")).toBeTruthy();
  });

  it("does not shift a timezone-local bucket into the previous day", () => {
    expect(
      formatDailySwingDate(
        "2026-08-10T04:00:00.000Z",
        "America/New_York",
        "en-US",
      ),
    ).toBe("Aug 10, 2026");
  });
});
