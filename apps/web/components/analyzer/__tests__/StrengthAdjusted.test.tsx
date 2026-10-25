import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StrengthCell, WinRateRange } from "../StrengthAdjusted";

afterEach(cleanup);
describe("strength cells and win-rate uncertainty", () => {
  it("exposes arithmetic and partial coverage without using all raw wins", () => {
    render(<StrengthCell row={{ ratedGames: 4, ratedWins: 2, expectedWins: 1.5, winsAboveExpected: .5, excludedNoMmr: 3, excludedIneligible: 1 }} />);
    expect(screen.getByRole("img", { name: /2 rated wins − 1.50 expected wins = \+0.5/ }).title).toContain("3 missing paired ratings");
    expect(screen.getByText("4 rated")).toBeTruthy(); expect(screen.getByText("+0.5")).toBeTruthy();
  });
  it("leaves unavailable history unknown and distinguishes it from a true neutral result", () => {
    const view = render(<StrengthCell row={{ ratedGames: 0, winsAboveExpected: null }} />); expect(screen.getByText("—")).toBeTruthy();
    view.rerender(<StrengthCell row={{ ratedGames: 2, ratedWins: 1, expectedWins: 1, winsAboveExpected: 0 }} />); expect(screen.getByText("±0.0")).toBeTruthy();
  });
  it("renders the supplied Wilson interval and the under-ten sample cue", () => {
    const view = render(<WinRateRange total={9} row={{ winRateRange: { low: .2, high: .8 } }} />);
    expect(screen.getByRole("img", { name: "95% Wilson range 20.0 to 80.0 percent" }).firstElementChild?.getAttribute("style")).toContain("left: 20%");
    expect(screen.getByText("thin sample")).toBeTruthy();
    view.rerender(<WinRateRange total={10} row={{ winRateRange: { low: -.1, high: 1.1 } }} />); expect(screen.queryByRole("img")).toBeNull(); expect(screen.queryByText("thin sample")).toBeNull();
  });
});
