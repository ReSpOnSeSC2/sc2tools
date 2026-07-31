import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpponentsTab } from "../OpponentsTab";

const useApiMock = vi.fn();
const useApiPaginatedMock = vi.fn();
const useAllNetMmrOpponentsMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

vi.mock("@/lib/useApiPaginated", () => ({
  useApiPaginated: (...args: unknown[]) => useApiPaginatedMock(...args),
}));

vi.mock("@/lib/netMmrOpponents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/netMmrOpponents")>();
  return {
    ...actual,
    useAllNetMmrOpponents: (...args: unknown[]) =>
      useAllNetMmrOpponentsMock(...args),
  };
});

vi.mock("@/lib/filterContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/filterContext")>();
  return {
    ...actual,
    useFilters: () => ({ filters: {}, dbRev: 7 }),
  };
});

vi.mock("@/lib/useLocalStorageState", () => ({
  useLocalStoragePositiveInt: (_key: string, initial: number) => [initial, vi.fn()],
  useLocalStorageState: <T,>(_key: string, initial: T) => [initial, vi.fn()],
}));

const opponents = [
  {
    pulseId: "alpha",
    pulseCharacterId: "101",
    toonHandle: "1-S2-1-101",
    name: "Alpha",
    wins: 2,
    losses: 1,
    games: 3,
    winRate: 2 / 3,
    mmr: 4100,
    lastPlayed: "2026-07-20T00:00:00.000Z",
  },
  {
    pulseId: "beta",
    pulseCharacterId: "202",
    toonHandle: "1-S2-1-202",
    name: "Beta",
    wins: 1,
    losses: 2,
    games: 3,
    winRate: 1 / 3,
    mmr: 4200,
    lastPlayed: "2026-07-21T00:00:00.000Z",
  },
];

const impacts = [
  {
    pulseId: "alpha",
    pulseCharacterId: "101",
    toonHandle: "1-S2-1-101",
    name: "Alpha",
    opponentRace: "P" as const,
    netMmr: 20,
    mmrWon: 40,
    mmrLost: 20,
    pairs: 2,
    wins: 1,
    losses: 1,
    winRate: 0.5,
    avgDelta: 10,
  },
  {
    pulseId: "beta",
    pulseCharacterId: "202",
    toonHandle: "1-S2-1-202",
    name: "Beta",
    opponentRace: "T" as const,
    netMmr: -30,
    mmrWon: 10,
    mmrLost: 40,
    pairs: 3,
    wins: 1,
    losses: 2,
    winRate: 1 / 3,
    avgDelta: -10,
  },
];

beforeEach(() => {
  useApiMock.mockReturnValue({ data: { links: {}, partial: false } });
  useApiPaginatedMock.mockReturnValue({
    items: opponents,
    isLoading: false,
    error: null,
    pagesFetched: 1,
    hitMaxPages: false,
  });
  useAllNetMmrOpponentsMock.mockReturnValue({
    items: impacts,
    summary: {
      netMmr: -10,
      mmrWon: 50,
      mmrLost: 60,
      pairs: 5,
      opponents: 2,
      mostMmrGainedFrom: impacts[0],
      mostMmrLostTo: impacts[1],
    },
    isLoading: false,
    error: null,
    pagesFetched: 1,
    hitMaxPages: false,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OpponentsTab MMR impact", () => {
  it("joins verified impact, shows both leaders, and filters by net result", () => {
    const onOpen = vi.fn();
    render(<OpponentsTab onOpen={onOpen} />);

    expect(
      screen.getByRole("button", { name: "Open Alpha, most MMR won" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open Beta, most MMR lost" }),
    ).toBeTruthy();

    const table = screen.getByRole("table");
    expect(table.className).toContain("min-w-[1020px]");
    const headerLabels = within(table)
      .getAllByRole("columnheader")
      .map((header) => (header.textContent || "").replace(/[↑↓]/g, "").trim());
    expect(headerLabels).toEqual([
      "Opponent",
      "Pulse ID",
      "W",
      "L",
      "Win rate",
      "Games",
      "Last MMR",
      "Net MMR",
      "MMR won",
      "MMR lost",
      "Last",
      "→",
    ]);

    const alphaRow = within(table).getByText("Alpha").closest("tr");
    expect(alphaRow).not.toBeNull();
    const alphaCells = within(alphaRow as HTMLTableRowElement).getAllByRole("cell");
    expect(alphaCells[2].textContent).toBe("2");
    expect(alphaCells[3].textContent).toBe("1");
    expect(alphaCells[4].textContent).toBe("66.7%");
    expect(alphaCells[5].textContent).toBe("3");
    expect(alphaCells[6].textContent).toBe("4100");
    expect(within(table).getByText("+20")).toBeTruthy();
    expect(within(table).getByText("-30")).toBeTruthy();
    expect(within(table).getByText("+40")).toBeTruthy();

    fireEvent.change(
      screen.getByRole("combobox", { name: "Filter opponents by MMR impact" }),
      { target: { value: "net-gain" } },
    );
    expect(within(table).getByText("Alpha")).toBeTruthy();
    expect(within(table).queryByText("Beta")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Open Alpha, most MMR won" }),
    );
    expect(onOpen).toHaveBeenCalledWith("alpha");

    fireEvent.click(
      screen.getByRole("button", { name: "Open Alpha opponent details" }),
    );
    expect(onOpen).toHaveBeenCalledWith("alpha");
  });

  it("keeps leader cards authoritative when the client-side join is truncated", () => {
    useAllNetMmrOpponentsMock.mockReturnValue({
      items: [impacts[0]],
      summary: {
        netMmr: -10,
        mmrWon: 50,
        mmrLost: 60,
        pairs: 5,
        opponents: 2,
        mostMmrGainedFrom: impacts[0],
        mostMmrLostTo: impacts[1],
      },
      isLoading: false,
      error: null,
      pagesFetched: 20,
      hitMaxPages: true,
    });

    render(<OpponentsTab onOpen={() => {}} />);

    expect(
      screen.getByRole("button", { name: "Open Beta, most MMR lost" }),
    ).toBeTruthy();
    expect(screen.getByText(/Some MMR impact rows were omitted/i)).toBeTruthy();
  });

  it("keeps expanded identity rows aligned with the record-first columns", () => {
    useApiMock.mockReturnValue({
      data: {
        links: {
          101: { accountId: "shared", proId: null, proNickname: null },
          202: { accountId: "shared", proId: null, proNickname: null },
        },
        partial: false,
      },
    });

    render(<OpponentsTab onOpen={() => {}} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Show the 2 names this player uses/i }),
    );

    const table = screen.getByRole("table", { name: "Opponent history" });
    const identityRows = within(table)
      .getAllByRole("row")
      .filter((row) => row.className.includes("bg-bg-elevated/40"));
    expect(identityRows).toHaveLength(2);

    const alphaIdentity = identityRows.find((row) =>
      within(row).queryByText("Alpha"),
    );
    expect(alphaIdentity).toBeTruthy();
    const cells = within(alphaIdentity as HTMLTableRowElement).getAllByRole("cell");
    expect(cells).toHaveLength(12);
    expect(cells[2].textContent).toBe("2");
    expect(cells[3].textContent).toBe("1");
    expect(cells[4].textContent).toBe("66.7%");
    expect(cells[5].textContent).toBe("3");
    expect(cells[6].textContent).toBe("4100");
  });

  it("does not mistake an impact request failure for an empty history", () => {
    useAllNetMmrOpponentsMock.mockReturnValue({
      items: [],
      summary: null,
      isLoading: false,
      error: new Error("offline"),
      pagesFetched: 0,
      hitMaxPages: false,
    });

    render(<OpponentsTab onOpen={() => {}} />);

    expect(
      screen.getByRole("alert").textContent,
    ).toContain("verified MMR impact is temporarily unavailable");
    expect(
      screen.queryByText(/No verified opponent MMR pairs match/i),
    ).toBeNull();
  });
});
