import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { BattlefieldTab } from "../BattlefieldTab";

const maps = [
  {
    name: "Ancient Cistern",
    wins: 9,
    losses: 1,
    total: 10,
    winRate: 0.9,
    recent: ["win", "loss", "win"] as const,
  },
  {
    name: "Ruby Rock",
    wins: 2,
    losses: 3,
    total: 5,
    winRate: 0.4,
    recent: ["loss", "win"] as const,
  },
  {
    name: "Custom Practice Map",
    wins: 2,
    losses: 2,
    total: 4,
    winRate: 0.5,
    recent: [] as const,
  },
];

const useApiMock = vi.fn((path: string) => {
  if (path.startsWith("/v1/maps/matchups")) {
    return {
      data: [
        {
          map: "Ancient Cistern",
          matchup: "vs Z",
          wins: 4,
          losses: 1,
          total: 5,
          winRate: 0.8,
        },
      ],
      isLoading: false,
    };
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
  return { data: maps, isLoading: false };
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

afterEach(() => {
  cleanup();
  useApiMock.mockClear();
});

describe("BattlefieldTab map gallery", () => {
  it("renders live map rows as sortable artwork cards with a local fallback", () => {
    render(<BattlefieldTab />);

    const gallery = screen.getByRole("list", {
      name: "Map performance gallery",
    });
    const cards = within(gallery).getAllByRole("article");

    expect(cards).toHaveLength(3);
    expect(cards[0].getAttribute("aria-label")).toContain("Ancient Cistern");
    expect(cards[0].getAttribute("aria-label")).toContain("90.0% win rate");
    expect(
      gallery.querySelectorAll("[data-map-artwork='image']").length,
    ).toBe(2);
    expect(
      gallery.querySelectorAll("[data-map-artwork='fallback']").length,
    ).toBe(1);

    fireEvent.change(screen.getByRole("combobox", { name: "Sort maps by" }), {
      target: { value: "name" },
    });
    expect(within(gallery).getAllByRole("article")[0].getAttribute("aria-label"))
      .toContain("Ruby Rock");

    fireEvent.click(
      screen.getByRole("button", { name: /Sort direction: descending/i }),
    );
    expect(within(gallery).getAllByRole("article")[0].getAttribute("aria-label"))
      .toContain("Ancient Cistern");
  });

  it("keeps map artwork labels in compact and matchup views", () => {
    render(<BattlefieldTab />);

    expect(screen.getAllByText("Ancient Cistern").length).toBeGreaterThan(2);
    expect(
      screen.getByRole("button", { name: /Sort direction: descending/i }),
    ).toBeTruthy();
    expect(useApiMock).toHaveBeenCalledWith("/v1/maps?scope=all#7");
    expect(useApiMock).toHaveBeenCalledWith("/v1/maps/matchups?scope=all#7");
  });
});
