import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { WinRateComparison, type WinRateComparisonRow } from "../WinRateComparison";

afterEach(cleanup);

function row(overrides: Partial<WinRateComparisonRow> = {}): WinRateComparisonRow {
  return { key: "sample", label: "Sample", games: 20, wins: 12, losses: 8, rate: 0.6, ...overrides };
}

describe("WinRateComparison", () => {
  it("keeps supplied rates and total records, including other outcomes, visible without interaction", () => {
    render(<WinRateComparison precision={1} baseline={0.518} rows={[row({ rate: 0.637, wins: 10, losses: 7 })]} />);
    const item = screen.getByRole("listitem");
    expect(within(item).getByText("63.7%")).toBeTruthy();
    expect(within(item).getByText("20 games · 10W · 7L · 3 other")).toBeTruthy();
    expect(screen.getByText("Overall 51.8%")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("distinguishes no games, no decided sample, and actual zero-percent results", () => {
    render(<WinRateComparison rows={[
      row({ key: "empty", label: "Empty", rate: null, games: 0, wins: 0, losses: 0 }),
      row({ key: "other", label: "Unknown", rate: 0, games: 7, wins: 0, losses: 0, sampleSize: 0 }),
      row({ key: "lost", label: "Losses", rate: 0, games: 5, wins: 0, losses: 5 }),
    ]} />);
    const items = screen.getAllByRole("listitem");
    expect(within(items[0]).getByText("No games")).toBeTruthy();
    expect(within(items[0]).getByText("—")).toBeTruthy();
    expect(within(items[1]).getByText("—")).toBeTruthy();
    expect(within(items[1]).getByText("7 games · 0W · 0L · 7 other")).toBeTruthy();
    expect(within(items[2]).getByText("0%")).toBeTruthy();
    expect(within(items[2]).getByText("Small sample")).toBeTruthy();
  });

  it("uses the rate sample rather than all records to qualify a comparison", () => {
    render(<WinRateComparison rows={[row({ games: 100, wins: 4, losses: 6, sampleSize: 10 })]} />);
    expect(screen.getByText("Small sample · n=10")).toBeTruthy();
    expect(screen.getByText(/fewer than 20 results/)).toBeTruthy();
  });

  it("uses a native accessible drilldown button without making read-only rows interactive", () => {
    const onSelect = vi.fn();
    render(<WinRateComparison rows={[
      row({ onSelect, ariaLabel: "Open the 20 matching games" }),
      row({ key: "plain", label: "Read-only", games: 1, wins: 1, losses: 0, rate: 1 }),
    ]} recordLabel="player game records" />);
    const button = screen.getByRole("button", { name: "Open the 20 matching games" });
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText("1 player game record · 1W · 0L")).toBeTruthy();
  });
});
