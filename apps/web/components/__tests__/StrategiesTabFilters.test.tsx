import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const useApiMock = vi.fn();
const useFiltersMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null) => useApiMock(path),
}));

vi.mock("@/lib/filterContext", async () => {
  const actual = await vi.importActual<typeof import("@/lib/filterContext")>(
    "@/lib/filterContext",
  );
  return {
    ...actual,
    useFilters: () => useFiltersMock(),
  };
});

import { StrategyFiltersBar } from "../analyzer/StrategiesTab";

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
  useFiltersMock.mockReset();
});

function readyResponse(data: unknown = []) {
  return { data, isLoading: false, error: null };
}

describe("StrategyFiltersBar", () => {
  it("scopes opponent-strategy options to the selected opponent race", () => {
    useFiltersMock.mockReturnValue({
      filters: {
        race: "P",
        opp_race: "T",
        build: "PvT - Robo First",
        opp_strategy: "TvP - Cyclone Push",
        map_pool: "ladder",
        game_size: "1v1",
      },
      setFilters: vi.fn(),
      dbRev: 17,
      bumpRev: vi.fn(),
      seasons: [],
    });
    useApiMock.mockImplementation((path: string) => {
      if (path.startsWith("/v1/opp-strategies")) {
        return readyResponse([
          { name: "TvP - Cyclone Push", total: 4 },
          { name: "Terran - Fast 3 CC", total: 2 },
        ]);
      }
      return readyResponse([]);
    });

    render(<StrategyFiltersBar />);

    const strategyRequest = useApiMock.mock.calls
      .map(([path]) => path as string)
      .find((path) => path.startsWith("/v1/opp-strategies"));
    expect(strategyRequest).toBeTruthy();

    const requestUrl = new URL(
      strategyRequest!.split("#", 1)[0],
      "https://sc2replaystats.test",
    );
    expect(requestUrl.searchParams.get("opp_race")).toBe("T");
    expect(requestUrl.searchParams.get("opp_strategy")).toBeNull();
    expect(requestUrl.searchParams.get("build")).toBeNull();
    expect(requestUrl.searchParams.get("race")).toBeNull();

    const strategySelect = screen.getByRole("combobox", {
      name: "Opp strategy",
    }) as HTMLSelectElement;
    expect(Array.from(strategySelect.options, (option) => option.value)).toEqual([
      "",
      "TvP - Cyclone Push",
      "Terran - Fast 3 CC",
    ]);
  });

  it("atomically clears the selected strategy when opponent race changes", () => {
    const setFilters = vi.fn();
    useFiltersMock.mockReturnValue({
      filters: {
        preset: "season",
        opp_race: "Z",
        opp_strategy: "ZvP - Hydra Timing",
        regions: "NA,EU",
      },
      setFilters,
      dbRev: 3,
      bumpRev: vi.fn(),
      seasons: [],
    });
    useApiMock.mockReturnValue(readyResponse([]));

    render(<StrategyFiltersBar />);
    fireEvent.change(screen.getByRole("combobox", { name: "Opp race" }), {
      target: { value: "T" },
    });

    expect(setFilters).toHaveBeenCalledTimes(1);
    expect(setFilters).toHaveBeenCalledWith({
      preset: "season",
      opp_race: "T",
      regions: "NA,EU",
    });
  });
});
