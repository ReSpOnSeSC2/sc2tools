import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrendsDataProvider } from "@/lib/trendsDataContext";
import { MapTrendChart } from "../MapTrendChart";

const { useApiMock, plotMock } = vi.hoisted(() => ({ useApiMock: vi.fn(), plotMock: vi.fn() }));

vi.mock("@/lib/clientApi", () => ({ useApi: (...args: unknown[]) => useApiMock(...args) }));
vi.mock("@/lib/filterContext", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/filterContext")>(),
  useFilters: () => ({ filters: { race: "P" }, dbRev: 3 }),
}));
vi.mock("@/lib/timeseries", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/timeseries")>(),
  clientTimezone: () => "America/New_York",
}));
vi.mock("@/components/maps/MapArtwork", () => ({ MapArtwork: () => null }));
vi.mock("@/components/maps/MapPreviewDialog", () => ({ MapPreviewDialog: () => null }));
vi.mock("../WinRateTrendPlot", async (importOriginal) => ({
  ...await importOriginal<typeof import("../WinRateTrendPlot")>(),
  WinRateTrendPlot: (props: unknown) => { plotMock(props); return null; },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const point = (key: string, wins: number, losses: number, day = "20") => ({
  key, wins, losses, total: wins + losses, bucket: `2026-08-${day}T04:00:00Z`,
});

describe("MapTrendChart sample-based form", () => {
  it("preserves duplicate daily records, weights games, and shares a calendar across maps", () => {
    useApiMock.mockReturnValue({ isLoading: false, data: { interval: "day", points: [
      point("Ruby Rock", 6, 4), point("Ruby Rock", 8, 2), point("Stone Falls", 0, 4, "22"),
    ] } });

    render(<MapTrendChart bucket="day" />);

    const ruby = plotMock.mock.calls.find(([props]) => props.label === "Ruby Rock recent win rate")![0];
    const stone = plotMock.mock.calls.find(([props]) => props.label === "Stone Falls recent win rate")![0];
    expect(ruby.trend.overall).toEqual({ games: 20, wins: 14, losses: 6, rate: 70 });
    expect(ruby.trend.points).toHaveLength(1);
    expect(ruby.trend.latest).toMatchObject({ ready: true, sampleGames: 20, rate: 70 });
    expect(stone.trend.latest).toMatchObject({ ready: false, sampleGames: 4, rate: null });
    expect(ruby.dateDomain).toEqual(["2026-08-20", "2026-08-22"]);
    expect(stone.dateDomain).toEqual(ruby.dateDomain);
    expect(screen.getByText("Building a sample")).toBeTruthy();
    expect(screen.getByText("4 / 20 games")).toBeTruthy();
  });

  it("always requests daily data and explains the actual returned whole-period sample", () => {
    useApiMock.mockReturnValue({ isLoading: false, data: { interval: "week", points: [point("Ruby Rock", 15, 15)] } });
    const { rerender } = render(<MapTrendChart bucket="week" />);
    const firstPath = useApiMock.mock.calls[0][0];
    expect(firstPath).toContain("interval=day");
    expect(firstPath).toContain("race=P");
    expect(firstPath).toContain("#3");
    expect(screen.getByText(/Samples keep whole weeks/)).toBeTruthy();
    expect(screen.getByText(/30 games ·/)).toBeTruthy();
    rerender(<MapTrendChart bucket="month" />);
    expect(useApiMock.mock.lastCall![0]).toBe(firstPath);
  });

  it("ranks maps by volume and provides touch-sized, stateful top-map controls", () => {
    useApiMock.mockReturnValue({ isLoading: false, data: { interval: "day", points:
      Array.from({ length: 9 }, (_, index) => point(`Map ${index + 1}`, index + 1, 0)),
    } });
    render(<MapTrendChart bucket="day" />);
    expect(screen.getAllByRole("heading", { level: 4 })).toHaveLength(6);
    expect(screen.getAllByRole("heading", { level: 4 })[0].textContent).toBe("Map 9");
    const four = screen.getByRole("button", { name: "Show top 4 maps" });
    expect(four.className).toContain("min-h-11");
    expect(four.className).toContain("min-w-11");
    fireEvent.click(four);
    expect(four.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByRole("heading", { level: 4 })).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Show top 8 maps" }));
    expect(screen.getAllByRole("heading", { level: 4 })).toHaveLength(8);
  });

  it("labels global samples as player game records and keeps the global request scope", () => {
    useApiMock.mockReturnValue({ isLoading: false, data: { interval: "day", points: [point("Ruby Rock", 2, 1)] } });
    render(<TrendsDataProvider mode="global"><MapTrendChart bucket="month" /></TrendsDataProvider>);
    expect(useApiMock.mock.calls[0][0]).toContain("/v1/admin/global-trends/timeseries/maps?");
    expect(screen.getByText("3 / 20 player game records")).toBeTruthy();
    expect(screen.getByText(/Each player game record has equal weight/)).toBeTruthy();
  });
});
