import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpponentsTab } from "../OpponentsTab";

const useApiMock = vi.fn();
const useApiPaginatedMock = vi.fn();
const useAllNetMmrOpponentsMock = vi.fn();
const usePlayerChannelsMock = vi.fn();

vi.mock("../usePlayerChannels", () => ({
  usePlayerChannels: (...args: unknown[]) => usePlayerChannelsMock(...args),
}));

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

vi.mock("@/lib/useLocalStorageState", async () => {
  const { useState } = await import("react");
  return {
    useLocalStoragePositiveInt: (_key: string, initial: number) => [initial, vi.fn()],
    useLocalStorageState: <T,>(_key: string, initial: T) => useState(initial),
  };
});

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
  usePlayerChannelsMock.mockReturnValue(() => undefined);
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

    const mostWon = screen.getByRole("button", {
      name: "Open Alpha, most net MMR won",
    });
    const mostLost = screen.getByRole("button", {
      name: "Open Beta, most net MMR lost",
    });
    expect(within(mostWon).getByText("+20")).toBeTruthy();
    expect(within(mostWon).queryByText("+40")).toBeNull();
    expect(within(mostLost).getByText("-30")).toBeTruthy();
    expect(within(mostLost).queryByText("-40")).toBeNull();

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
      screen.getByRole("button", { name: "Open Alpha, most net MMR won" }),
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
      screen.getByRole("button", { name: "Open Beta, most net MMR lost" }),
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

  it("keeps an approved barcode beside AKA with channels when grouped, expanded, or ungrouped", () => {
    const barcode = "IIlIIlIl";
    const globalIdentity = {
      groupKey: "player:236671", displayName: "Strange",
      target: { key: "pulse:236671", pulseCharacterId: "236671" },
    };
    useApiPaginatedMock.mockReturnValue({
      items: [
        { ...opponents[0], pulseId: "8703807", pulseCharacterId: "8703807", name: barcode, revealedName: "StaleName", globalIdentity, lastPlayed: "2026-09-07T00:00:00Z" },
        { ...opponents[1], pulseId: "236671", pulseCharacterId: "236671", name: "MainAccount", globalIdentity, lastPlayed: "2026-09-01T00:00:00Z" },
      ],
      isLoading: false, error: null, pagesFetched: 1, hitMaxPages: false,
    });
    usePlayerChannelsMock.mockReturnValue(() => ({ twitch: "https://www.twitch.tv/strange", youtube: "https://www.youtube.com/@strange" }));
    const onOpen = vi.fn();
    render(<OpponentsTab onOpen={onOpen} />);
    const table = screen.getByRole("table", { name: "Opponent history" });
    const grouped = within(table).getByText(barcode).closest("tr")!;
    expect(within(grouped).getByText("aka")).toBeTruthy();
    expect(within(grouped).getByTitle("Confirmed as Strange").textContent).toBe("akaStrange");
    expect(within(grouped).queryByText("StaleName")).toBeNull();
    expect(within(grouped).getAllByRole("cell")[5].textContent).toBe("6");
    expect(within(grouped).getByRole("link", { name: "Visit Strange's Twitch channel" }).getAttribute("href")).toBe("https://www.twitch.tv/strange");
    expect(within(grouped).getByRole("link", { name: "Visit Strange's YouTube channel" })).toBeTruthy();
    fireEvent.click(within(grouped).getByRole("button", { name: `Open ${barcode} opponent details` }));
    expect(onOpen).toHaveBeenLastCalledWith("8703807");

    fireEvent.click(screen.getByRole("button", { name: "Show the 2 names this player uses" }));
    const expanded = within(table).getAllByRole("row").filter((row) => row.className.includes("bg-bg-elevated/40"));
    expect(expanded).toHaveLength(2);
    const source = expanded.find((row) => within(row).queryByText(barcode))!;
    expect(within(source).getByTitle("Confirmed as Strange")).toBeTruthy();
    expect(within(source).getByRole("link", { name: "Visit Strange's YouTube channel" })).toBeTruthy();
    expect(within(source).getAllByRole("cell")[5].textContent).toBe("3");

    fireEvent.click(screen.getByRole("switch", { name: "Group same player" }));
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    const separate = within(table).getByText(barcode).closest("tr")!;
    expect(within(separate).getByTitle("Confirmed as Strange")).toBeTruthy();
    expect(within(separate).getByRole("link", { name: "Visit Strange's Twitch channel" })).toBeTruthy();
    expect(within(separate).getAllByRole("cell")[5].textContent).toBe("3");
    const search = screen.getByRole("textbox", { name: "Search opponents" });
    fireEvent.change(search, { target: { value: "Strange" } });
    expect(within(table).getByText(barcode)).toBeTruthy();
    expect(within(table).getByText("MainAccount")).toBeTruthy();
    fireEvent.change(search, { target: { value: barcode } });
    expect(within(table).getByText(barcode)).toBeTruthy();
    expect(within(table).queryByText("MainAccount")).toBeNull();
  });
});
