import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WhereGamesEndBar } from "../WhereGamesEndBar";

afterEach(cleanup);

describe("WhereGamesEndBar", () => {
  it("renders nothing when the distribution sums to zero", () => {
    const { container } = render(
      <WhereGamesEndBar
        finalPhaseDistribution={{ early: 0, earlyMid: 0, mid: 0, midLate: 0, late: 0 }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when no distribution is provided", () => {
    const { container } = render(<WhereGamesEndBar />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the stacked outcome bar with the total game count and no 'reached by' suffix", () => {
    render(
      <WhereGamesEndBar
        finalPhaseDistribution={{
          early: 1,
          earlyMid: 5,
          mid: 0,
          midLate: 0,
          late: 3,
        }}
      />,
    );
    const bar = screen.getByLabelText(
      /Phase the game ended in, across all matches/i,
    );
    expect(bar).toBeTruthy();
    expect(screen.getByText("9 games")).toBeTruthy();
    expect(screen.queryByText(/reached by/i)).toBeNull();
  });

  it("opens a popover with the game count when a sliver is clicked and closes it on a second click", () => {
    render(
      <WhereGamesEndBar
        finalPhaseDistribution={{
          early: 5,
          earlyMid: 15,
          mid: 3,
          midLate: 0,
          late: 15,
        }}
      />,
    );
    const earlyMidSliver = screen
      .getAllByTestId("phase-final-bar")
      .find((el) => el.getAttribute("data-phase") === "earlyMid");
    expect(earlyMidSliver).toBeTruthy();
    fireEvent.click(earlyMidSliver!);
    const popover = screen.getByRole("status");
    expect(popover.textContent).toMatch(/Early\/Mid/);
    expect(popover.textContent).toMatch(/15/);
    expect(popover.textContent).toMatch(/games/);
    expect(earlyMidSliver!.getAttribute("data-selected")).toBe("1");
    fireEvent.click(earlyMidSliver!);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
