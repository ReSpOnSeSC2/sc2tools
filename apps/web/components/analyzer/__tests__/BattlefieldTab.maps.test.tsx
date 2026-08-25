import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { BattlefieldTab } from "../BattlefieldTab";

const mapMatchups = [
  {
    map: "Ancient Cistern",
    matchup: "vs Z",
    wins: 4,
    losses: 1,
    total: 5,
    winRate: 0.8,
  },
  {
    map: "Ancient Cistern",
    matchup: "vs T",
    wins: 1,
    losses: 1,
    total: 2,
    winRate: 0.5,
  },
  {
    map: "Ruby Rock",
    matchup: "vs P",
    wins: 2,
    losses: 3,
    total: 5,
    winRate: 0.4,
  },
  {
    map: "Custom Practice Map",
    matchup: "vs P",
    wins: 3,
    losses: 0,
    total: 3,
    winRate: 1,
  },
  {
    map: "Hidden Training Map",
    matchup: "vs Z",
    wins: 2,
    losses: 0,
    total: 2,
    winRate: 1,
  },
];

const useApiMock = vi.fn((path: string) => {
  if (path.startsWith("/v1/maps/matchups")) {
    return { data: mapMatchups, isLoading: false };
  }
  if (path.startsWith("/v1/matchups")) {
    return {
      data: [
        {
          name: "vs Z",
          wins: 4,
          losses: 1,
          total: 5,
          winRate: 0.8,
        },
      ],
      isLoading: false,
    };
  }
  throw new Error(`Unexpected API request: ${path}`);
});

vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string) => useApiMock(path),
}));

vi.mock("@/lib/filterContext", () => ({
  useFilters: () => ({ filters: {}, dbRev: 7 }),
  filtersToQuery: () => "?scope=all",
}));

vi.mock("@/lib/useLocalStorageState", () => ({
  useLocalStoragePositiveInt: () => [3, vi.fn()],
}));

vi.mock("@/components/maps/MapPreviewDialog", () => ({
  MapPreviewDialog: ({
    mapName,
    onClose,
  }: {
    mapName: string | null;
    onClose: () => void;
  }) =>
    mapName ? (
      <div role="dialog" aria-label={`${mapName} map preview`}>
        <button type="button" onClick={onClose}>
          Close preview
        </button>
      </div>
    ) : null,
}));

afterEach(() => {
  cleanup();
  useApiMock.mockClear();
});

function mapOrder(): string[] {
  const list = screen.getByRole("list", {
    name: "Map performance by matchup",
  });
  return within(list)
    .getAllByRole("button", { name: /Open larger preview of/i })
    .map((button) => button.getAttribute("aria-label") || "");
}

describe("BattlefieldTab map performance", () => {
  it("uses one combined map panel and keeps the matchup min-games semantics", () => {
    render(<BattlefieldTab />);

    expect(
      screen.getByRole("heading", { name: "Win rate by map by matchup" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Win rate by map" }),
    ).toBeNull();
    expect(screen.queryByText("vs T")).toBeNull();
    expect(screen.queryByText("Hidden Training Map")).toBeNull();

    const ancientGroup = screen
      .getByRole("button", { name: "Open larger preview of Ancient Cistern" })
      .closest("li");
    expect(ancientGroup).not.toBeNull();
    expect(within(ancientGroup!).getByText("5W")).toBeTruthy();
    expect(within(ancientGroup!).getByText("2L")).toBeTruthy();
    expect(within(ancientGroup!).getByText("71.4%")).toBeTruthy();

    expect(useApiMock).toHaveBeenCalledWith("/v1/matchups?scope=all#7");
    expect(useApiMock).toHaveBeenCalledWith(
      "/v1/maps/matchups?scope=all#7",
    );
    expect(useApiMock).not.toHaveBeenCalledWith("/v1/maps?scope=all#7");
  });

  it("sorts the combined map groups by every supported metric and direction", () => {
    render(<BattlefieldTab />);

    const select = screen.getByRole("combobox", { name: "Sort maps by" });
    expect(
      within(select).getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Map", "Win rate", "Games", "Wins", "Losses"]);
    expect(mapOrder()[0]).toContain("Custom Practice Map");

    fireEvent.change(select, { target: { value: "map" } });
    expect(mapOrder()[0]).toContain("Ruby Rock");
    fireEvent.click(
      screen.getByRole("button", { name: /Sort direction: descending/i }),
    );
    expect(mapOrder()[0]).toContain("Ancient Cistern");

    for (const [metric, firstMap] of [
      ["winRate", "Ruby Rock"],
      ["total", "Custom Practice Map"],
      ["wins", "Ruby Rock"],
      ["losses", "Custom Practice Map"],
    ]) {
      fireEvent.change(select, { target: { value: metric } });
      expect(mapOrder()[0]).toContain(firstMap);
    }
  });

  it("opens the shared large preview from an accessible map trigger", () => {
    render(<BattlefieldTab />);

    const trigger = screen.getByRole("button", {
      name: "Open larger preview of Ancient Cistern",
    });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.className).toContain("min-h-11");

    fireEvent.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "Ancient Cistern map preview" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
