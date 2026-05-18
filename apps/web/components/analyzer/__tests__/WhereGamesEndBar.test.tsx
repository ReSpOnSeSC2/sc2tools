import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

  it("renders the stacked outcome bar with the total game count", () => {
    render(
      <WhereGamesEndBar
        finalPhaseDistribution={{
          early: 1,
          earlyMid: 5,
          mid: 0,
          midLate: 0,
          late: 3,
        }}
        sampleSize={{ early: 9, earlyMid: 8, mid: 3, midLate: 3, late: 3 }}
      />,
    );
    const bar = screen.getByLabelText(
      /Phase the game ended in, across all matches/i,
    );
    expect(bar).toBeTruthy();
    expect(screen.getByText("9 games")).toBeTruthy();
    expect(screen.getByText(/reached by 9/i)).toBeTruthy();
    expect(screen.getByText(/reached by 8/i)).toBeTruthy();
  });
});
