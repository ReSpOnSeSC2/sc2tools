import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WinRateSampleSummary, WinRateTrendPlot } from "../WinRateTrendPlot";
import { buildWinRateTrend, type WinRatePeriod } from "@/lib/winRateTrend";

const period = (date: string, wins: number, losses: number, games = wins + losses): WinRatePeriod => ({ date, wins, losses, games });

// Exercise the real SVG renderer, including missing-value handling and dots.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const measurement = this.id === "recharts_measurement_span";
    const width = measurement ? (this.textContent?.length ?? 0) * 6 : 720;
    const height = measurement ? 12 : 320;
    return { width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({}) };
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(720);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("WinRateTrendPlot", () => {
  it("does not draw a trace or an overall reference before the requested sample is ready", () => {
    const trend = buildWinRateTrend([period("2026-09-01", 4, 1)], 30);
    const { container } = render(<WinRateTrendPlot trend={trend} />);
    expect(container.textContent).toBe("");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("makes the first eligible sample visible as a dot with an explanation", () => {
    const trend = buildWinRateTrend([period("2026-09-01", 18, 12)], 30);
    const { container } = render(<WinRateTrendPlot trend={trend} />);
    expect(container.querySelectorAll(".recharts-line-dot")).toHaveLength(1);
    const dot = container.querySelector(".recharts-line-dot");
    expect(dot?.getAttribute("fill")).toBe(dot?.getAttribute("stroke"));
    expect(screen.getByText(/First sample ready/)).toBeTruthy();
    expect(container.querySelectorAll(".recharts-reference-line-line")).toHaveLength(1);
  });

  it("renders sparse played samples across idle days without hiding or extending the trace", () => {
    const trend = buildWinRateTrend([
      period("2026-09-01", 20, 10),
      period("2026-09-02", 0, 0),
      period("2026-09-04", 18, 12),
      period("2026-09-05", 0, 0),
      period("2026-09-08", 15, 15),
      period("2026-09-10", 0, 0),
    ], 30);
    const { container } = render(<WinRateTrendPlot trend={trend} />);
    const path = container.querySelector(".recharts-line-curve")?.getAttribute("d") ?? "";
    // Three isolated move commands have no visible length; a connecting line
    // or explicit dots must survive even though there are more than two samples.
    expect(/[LC]/.test(path) || container.querySelectorAll(".recharts-line-dot").length >= 3).toBe(true);
    expect(path.match(/M/g)).toHaveLength(1);
    expect(trend.latest?.date).toBe("2026-09-08");
    expect(trend.points.at(-1)?.rate).toBeNull();
  });

  it("keeps a full percentage scale and an accessible description at compact map size", () => {
    const trend = buildWinRateTrend([period("2026-09-01", 15, 15), period("2026-09-02", 18, 12)], 30);
    const { container } = render(<WinRateTrendPlot trend={trend} compact label="Gold Base recent form" />);
    const chart = screen.getByRole("application", { name: "Gold Base recent form" });
    expect(chart.getAttribute("tabindex")).toBe("0");
    const description = document.getElementById(chart.getAttribute("aria-describedby")!);
    expect(description?.textContent).toContain("at least 30 games");
    expect(description?.textContent).toContain("zero to one hundred percent");
    expect(description?.textContent).toContain("left and right arrow keys");
    const ticks = [...container.querySelectorAll(".recharts-yAxis .recharts-cartesian-axis-tick-value")].map(node => node.textContent);
    expect(ticks).toEqual(["0%", "50%", "100%"]);
  });

  it("exposes window dates and actual records when a keyboard user explores a point", async () => {
    const trend = buildWinRateTrend([period("2026-09-01", 20, 5, 30), period("2026-09-02", 2, 3)], 30);
    render(<WinRateTrendPlot trend={trend} label="Recent win rate" />);
    const chart = screen.getByRole("application", { name: "Recent win rate" });
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByText(/35 games · 22W · 8L · 5 other/)).toBeTruthy());
    expect(screen.getByText("Sep 1, 2026 – Sep 2, 2026")).toBeTruthy();
    expect(screen.getByText("62.9%")).toBeTruthy();
  });

  it("keeps the current sample's dates and count available without hover or pointer input", () => {
    const trend = buildWinRateTrend([period("2025-12-31", 18, 12), period("2026-01-02", 1, 1)], 30);
    render(<WinRateSampleSummary trend={trend} targetGames={30} />);
    expect(screen.getByText("59.4%")).toBeTruthy();
    expect(screen.getByText(/32 games · 19W · 13L/)).toBeTruthy();
    expect(screen.getByText("Dec 31, 2025 – Jan 2, 2026")).toBeTruthy();
  });
});
