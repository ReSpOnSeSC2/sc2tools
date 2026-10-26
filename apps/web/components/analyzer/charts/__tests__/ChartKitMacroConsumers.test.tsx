import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ScoreBucketsCard } from "../../macro/report/ScoreBucketsCard";
import { MacroTrendChart } from "../MacroTrendChart";
import { FormSparkline } from "../FormSparkline";

afterEach(cleanup);
describe("shared macro/form projections retain their records and actions", () => {
  it("shows categorical macro rates/counts without a dual-axis plot and preserves exact drill boundaries", () => {
    const onDrill = vi.fn();
    render(<ScoreBucketsCard onDrill={onDrill} buckets={[
      { key: "low", label: "Below60", min: null, max: 60, games: 8, wins: 2, losses: 4, winRate: .37, avgScore: 45 },
      { key: "high", label: "80+", min: 80, max: null, games: 20, wins: 12, losses: 8, winRate: .6, avgScore: 85 },
    ]} />);
    expect(screen.getByText("37%")).toBeTruthy(); expect(screen.getByText("8 games · 2W · 4L · 2 other")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Games with macro Below60" })); expect(onDrill).toHaveBeenLastCalledWith({ title: "Games with macro Below60", params: { macro_max: 60 } });
    fireEvent.click(screen.getByRole("button", { name: /View as table/ }));
    const table = screen.getByRole("table"); expect(within(table).getByText("37%")).toBeTruthy();
    fireEvent.click(within(table).getByRole("button", { name: "80+" })); expect(onDrill).toHaveBeenLastCalledWith({ title: "Games with macro 80+", params: { macro_min: 80 } });
    expect(document.querySelector(".recharts-wrapper")).toBeNull();
  });
  it("uses20 measured samples for mechanics cues without altering averages or calendar gaps", () => {
    const view = render(<MacroTrendChart metric="macro" bucket="day" series={[
      { date: "2026-10-01", games: 19, wins: 10, losses: 9, winRate: .5, avgMacroScore: 61, macroN: 19 },
      { date: "2026-10-03", games: 20, wins: 10, losses: 10, winRate: .5, avgMacroScore: 79, macroN: 20 },
    ]} />);
    expect(view.container.querySelector('circle[data-n="19"]')?.getAttribute("data-hollow")).toBe("true");
    expect(view.container.querySelector('circle[data-n="20"]')?.getAttribute("data-hollow")).toBe("false");
    expect(screen.getByTestId("mechanics-trend-line").getAttribute("d")?.match(/M/g)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /View as table/ }));
    expect(within(screen.getByRole("table")).getByText("61")).toBeTruthy(); expect(within(screen.getByRole("table")).getByText("79")).toBeTruthy();
  });
  it("makes newest-first form readable oldest-first as shapes and a table without invented dates", () => {
    const view = render(<FormSparkline results={["win", "loss", "loss"]} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Recent form, oldest to newest: loss, loss, win");
    expect(view.container.querySelectorAll('[data-hollow="true"]')).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /View as table/ }));
    expect(within(screen.getByRole("table")).getAllByRole("row").slice(1).map(row => row.textContent)).toEqual(["1Loss", "2Loss", "3Win"]);
  });
});
