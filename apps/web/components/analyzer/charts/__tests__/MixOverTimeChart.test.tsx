import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MixOverTimeChart } from "../MixOverTimeChart";

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

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ||
  ResizeObserverStub;

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
  useFiltersMock.mockReset();
});

const BASE_PROPS = {
  endpoint: "timeseries/my-builds",
  title: "Your build mix over time",
  caption: "Build mix.",
  bucket: "week" as const,
};

describe("MixOverTimeChart matchup filter", () => {
  it("requests and labels the selected opponent matchup", () => {
    useFiltersMock.mockReturnValue({
      filters: { race: "P", since: "2026-07-01T00:00:00.000Z" },
      dbRev: 7,
    });
    useApiMock.mockReturnValue({
      data: {
        interval: "week",
        points: [
          {
            bucket: "2026-07-12T00:00:00.000Z",
            key: "PvZ - Stargate into Glaives",
            wins: 2,
            losses: 1,
            total: 3,
          },
        ],
      },
      isLoading: false,
    });
    const onChange = vi.fn();

    render(
      <MixOverTimeChart
        {...BASE_PROPS}
        matchupFilter={{ opponentRace: "Z", onChange }}
      />,
    );

    const matchup = screen.getByRole("combobox", {
      name: "Your build mix over time matchup",
    }) as HTMLSelectElement;
    expect(matchup.value).toBe("Z");
    expect(
      within(matchup)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["All matchups", "PvP", "PvT", "PvZ"]);

    const request = String(useApiMock.mock.calls[0]?.[0]);
    expect(request).toContain("/v1/timeseries/my-builds?");
    expect(request).toContain("race=P");
    expect(request).toContain("opp_race=Z");
    expect(request).toContain("interval=week");
    expect(request).toContain("#7");

    fireEvent.change(matchup, { target: { value: "T" } });
    expect(onChange).toHaveBeenCalledWith("T");
  });

  it("keeps the matchup selector available when that scope has no games", () => {
    useFiltersMock.mockReturnValue({ filters: {}, dbRev: 0 });
    useApiMock.mockReturnValue({
      data: { interval: "week", points: [] },
      isLoading: false,
    });

    render(
      <MixOverTimeChart
        {...BASE_PROPS}
        emptyTitle="No build mix yet"
        matchupFilter={{ opponentRace: "T", onChange: vi.fn() }}
      />,
    );

    expect(screen.getByText("No build mix yet")).toBeTruthy();
    const matchup = screen.getByRole("combobox", {
      name: "Your build mix over time matchup",
    });
    expect(
      within(matchup)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "All matchups",
      "vs Protoss",
      "vs Terran",
      "vs Zerg",
    ]);
  });

  it("lets All matchups clear a global opponent-race constraint for these cards", () => {
    useFiltersMock.mockReturnValue({
      filters: { opp_race: "P" },
      dbRev: 0,
    });
    useApiMock.mockReturnValue({
      data: { interval: "week", points: [] },
      isLoading: false,
    });

    render(
      <MixOverTimeChart
        {...BASE_PROPS}
        matchupFilter={{ opponentRace: "", onChange: vi.fn() }}
      />,
    );

    const request = String(useApiMock.mock.calls[0]?.[0]);
    expect(request).not.toContain("opp_race=");
  });
});
