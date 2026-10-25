import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpponentsTab } from "../OpponentsTab";

const useApiMock = vi.fn();
const useApiPaginatedMock = vi.fn();
const useAllNetMmrOpponentsMock = vi.fn();
const usePlayerChannelsMock = vi.fn();
const useFiltersMock = vi.fn();
const useRivalsMock = vi.fn();
const useRivalSummaryMock = vi.fn();
const downloadCsvMock = vi.fn();
vi.mock("@/lib/csvExport", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/csvExport")>(), downloadCsv: (...args: unknown[]) => downloadCsvMock(...args) }));

vi.mock("@/lib/useRivals", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/useRivals")>(), useRivals: () => useRivalsMock() }));
vi.mock("@/lib/useRivalSummary", () => ({ useRivalSummary: (...args: unknown[]) => useRivalSummaryMock(...args) }));

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
    useFilters: () => useFiltersMock(),
  };
});

vi.mock("@/lib/useLocalStorageState", async () => {
  const { useState } = await import("react");
  return {
    useLocalStoragePositiveInt: (_key: string, initial: number) => useState(initial),
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
  downloadCsvMock.mockReset();
  useRivalsMock.mockReturnValue({ owner: "owner-a", keys: [], toggle: vi.fn(), loading: false, saving: false });
  useRivalSummaryMock.mockReturnValue({ data: undefined, error: false, loading: false, retry: vi.fn() });
  useFiltersMock.mockReturnValue({ filters: {}, dbRev: 7 });
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
  sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("opponent list controls and navigation", () => {
  it("uses dossier links and leaves modified row clicks, alias buttons and selected text alone", () => {
    const onOpen = vi.fn(); render(<OpponentsTab onOpen={onOpen} />);
    const table = screen.getByRole("table");
    const name = within(table).getByRole("link", { name: "Alpha" });
    expect(name.getAttribute("href")).toBe("/app/opponents/alpha");
    const row = name.closest("tr")!;
    for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) fireEvent.click(row, { [modifier]: true });
    fireEvent.click(row, { button: 1 });
    expect(onOpen).not.toHaveBeenCalled();
    const selection = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "Copied name" } as Selection);
    fireEvent.click(row); expect(onOpen).not.toHaveBeenCalled(); selection.mockRestore();
    fireEvent.click(row); expect(onOpen).toHaveBeenCalledWith("alpha");
    expect(within(table).getByRole("columnheader", { name: /Open dossier/ })).toBeTruthy();
    expect(row.querySelector("time")?.getAttribute("dateTime")).toBe(opponents[0].lastPlayed);
  });
  it("focuses search with slash, clears with Escape or its button, and resets only local controls", () => {
    render(<><input aria-label="Other editor" /><OpponentsTab onOpen={() => undefined} /></>);
    const search = screen.getByRole("textbox", { name: "Search opponents" });
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    fireEvent.keyDown(window, { key: "/" }); expect(document.activeElement).toBe(search);
    const other = screen.getByRole("textbox", { name: "Other editor" }); other.focus(); fireEvent.keyDown(other, { key: "/" }); expect(document.activeElement).toBe(other);
    fireEvent.change(search, { target: { value: "Alpha" } }); fireEvent.keyDown(search, { key: "Escape" }); expect((search as HTMLInputElement).value).toBe("");
    fireEvent.change(search, { target: { value: "Beta" } }); fireEvent.click(screen.getByRole("button", { name: "Clear search" })); expect((search as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("switch", { name: "Group same player" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Filter opponents by MMR impact" }), { target: { value: "tracked" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull(); expect(screen.getByRole("switch", { name: "Group same player" }).getAttribute("aria-checked")).toBe("true");
    expect(useFiltersMock.mock.results.at(-1)?.value.filters).toEqual({});
  });
  it("filters notes across grouped members, shows more previews, and keeps legacy notes readable", () => {
    useApiMock.mockReturnValue({ data: { links: { 101: { accountId: "same" }, 202: { accountId: "same" } } } });
    useApiPaginatedMock.mockReturnValue({ items: [{ ...opponents[0], notesMeta: { preview: "Check the third" } }, { ...opponents[1], notes: "Legacy note" }], isLoading: false });
    render(<OpponentsTab onOpen={() => undefined} />);
    fireEvent.click(screen.getByRole("switch", { name: "Has notes" }));
    expect(screen.getByRole("table").querySelectorAll("tbody tr")).toHaveLength(1);
    expect(screen.getByText("+1 more")).toBeTruthy(); expect(screen.getByRole("button", { name: /^Scouting note:/ }).getAttribute("title")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Group same player" }));
    expect(screen.getByRole("table").querySelectorAll("tbody tr")).toHaveLength(2); expect(screen.getByRole("button", { name: "Scouting note: Legacy note" })).toBeTruthy();
  });
  it("debounces row prefetch through one timer and reports the page cap without page jargon", () => {
    vi.useFakeTimers(); const prefetch = vi.fn();
    useApiPaginatedMock.mockReturnValue({ items: opponents, isLoading: false, hitMaxPages: true });
    render(<OpponentsTab onOpen={() => undefined} location={{ pathname: "/app/opponents", query: "", replace: vi.fn(), prefetch, navigate: vi.fn() }} />);
    const table = screen.getByRole("table"); const alpha = within(table).getByRole("link", { name: "Alpha" }).closest("tr")!; const beta = within(table).getByRole("link", { name: "Beta" }).closest("tr")!;
    fireEvent.pointerEnter(alpha); act(() => vi.advanceTimersByTime(100)); fireEvent.pointerEnter(beta); act(() => vi.advanceTimersByTime(149)); expect(prefetch).not.toHaveBeenCalled(); act(() => vi.advanceTimersByTime(1)); expect(prefetch).toHaveBeenCalledOnce(); expect(prefetch).toHaveBeenCalledWith("/app/opponents/beta");
    expect(screen.getByText(/Showing your most recent 8,000 opponents/)).toBeTruthy(); expect(screen.queryByText(/\d+ pages/)).toBeNull();
  });
  it("restores the saved render window before scrolling and clears the return flag", () => {
    vi.useFakeTimers(); window.history.replaceState({}, "", "/app/opponents");
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    sessionStorage.setItem("opponents:from-list", "1");
    sessionStorage.setItem("opponents:list-state", JSON.stringify({ listUrl: "/app/opponents", renderWindow: 400, expandedGroups: [], scrollY: 950 }));
    useApiPaginatedMock.mockReturnValue({ items: Array.from({ length: 450 }, (_, index) => ({ ...opponents[0], pulseId: String(index), pulseCharacterId: String(index), name: `Player ${index}` })), isLoading: false });
    render(<OpponentsTab onOpen={() => undefined} />);
    expect(screen.getByRole("table").querySelectorAll("tbody tr")).toHaveLength(400);
    expect(scroll).not.toHaveBeenCalled(); act(() => vi.advanceTimersByTime(40));
    expect(scroll).toHaveBeenCalledWith(0, 950); expect(sessionStorage.getItem("opponents:from-list")).toBeNull(); scroll.mockRestore();
  });
});

function mockGroupedImpacts(identitySource: "pulse" | "approved" = "pulse") {
  const rows = [
    { name: "StimPacker", netMmr: 115, mmrWon: 115, mmrLost: 0, pairs: 11 },
    { name: "Gainer", netMmr: 80, mmrWon: 160, mmrLost: 80, pairs: 10 },
    { name: "GainerAlt", netMmr: 60, mmrWon: 83, mmrLost: 23, pairs: 7 },
    { name: "papito", netMmr: -111, mmrWon: 0, mmrLost: 111, pairs: 8 },
    { name: "Loser", netMmr: -70, mmrWon: 0, mmrLost: 70, pairs: 6 },
    { name: "LoserAlt", netMmr: -60, mmrWon: 0, mmrLost: 60, pairs: 5 },
  ].map((row, index) => ({
    ...impacts[0],
    ...row,
    pulseId: row.name.toLowerCase(),
    pulseCharacterId: String(index + 1),
    toonHandle: `1-S2-1-${index + 1}`,
    avgDelta: row.netMmr / row.pairs,
    lastPlayed: `2026-09-0${index + 1}T00:00:00.000Z`,
  }));
  const playerKey = (index: number) =>
    index === 1 || index === 2 ? "gainer" : index === 4 || index === 5 ? "loser" : null;
  useApiPaginatedMock.mockReturnValue({
    items: rows.map((row, index) => ({
      ...opponents[0],
      ...row,
      games: row.pairs,
      ...(identitySource === "approved" && playerKey(index) ? {
        globalIdentity: {
          groupKey: `player:${playerKey(index)}`,
          displayName: playerKey(index),
          target: { key: `pulse:${row.pulseCharacterId}` },
        },
      } : {}),
    })),
    isLoading: false, error: null, pagesFetched: 1, hitMaxPages: false,
  });
  useApiMock.mockReturnValue({
    data: {
      links: identitySource === "pulse" ? Object.fromEntries(rows.map((row, index) => [
        row.pulseCharacterId,
        { accountId: playerKey(index), proId: null, proNickname: null },
      ])) : {},
      partial: false,
    },
  });
  useAllNetMmrOpponentsMock.mockReturnValue({
    items: rows,
    summary: {
      netMmr: 14, mmrWon: 358, mmrLost: 344, pairs: 47, opponents: 6,
      mostMmrGainedFrom: rows[0], mostMmrLostTo: rows[3],
    },
    isLoading: false, error: null, pagesFetched: 1, hitMaxPages: false,
  });
}

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
    expect(table.style.minWidth).toBe("816px");
    const headerLabels = within(table)
      .getAllByRole("columnheader")
      .map((header) => (header.textContent || "").replace(/[↑↓]/g, "").trim());
    expect(headerLabels).toEqual([
      "Opponent",
      "Race",
      "W",
      "L",
      "Win rate",
      "Games",
      "Last MMR",
      "Net MMR",
      "Last",
      "Open dossier→",
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
    expect(within(table).queryByText("+40")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "MMR won" }));
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
      screen.getByRole("link", { name: "Open dossier for Alpha" }),
    );
    expect(onOpen).toHaveBeenCalledWith("alpha");
  });

  it.each(["pulse", "approved"] as const)("ranks %s player groups by net MMR and opens the same profile as the table", (identitySource) => {
    mockGroupedImpacts(identitySource);
    const onOpen = vi.fn();
    render(<OpponentsTab onOpen={onOpen} />);
    const table = screen.getByRole("table", { name: "Opponent history" });
    for (const [kind, value, pairs] of [["won", "+140", 17], ["lost", "-130", 11]] as const) {
      const card = screen.getByRole("button", { name: new RegExp(`most net MMR ${kind}$`) });
      expect(within(card).getByText(value)).toBeTruthy();
      expect(within(card).getByText(`${pairs} verified pairs`)).toBeTruthy();
      const row = within(table).getByText(value, { selector: "span" }).closest("tr")!;
      fireEvent.click(card);
      const cardTarget = onOpen.mock.lastCall?.[0];
      fireEvent.click(within(row).getByRole("link", { name: /^Open dossier for/ }));
      expect(onOpen).toHaveBeenLastCalledWith(cardTarget);
    }

    fireEvent.click(screen.getByRole("switch", { name: "Group same player" }));
    const mostWon = screen.getByRole("button", { name: "Open StimPacker, most net MMR won" });
    expect(within(mostWon).getByText("+115")).toBeTruthy();
    expect(within(mostWon).getByText("11 verified pairs")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: "Open papito, most net MMR lost" })).getByText("-111")).toBeTruthy();
    expect(within(table).queryByText("+140")).toBeNull();
  });

  it("keeps grouped leaders scoped to global filters while table controls change", () => {
    mockGroupedImpacts();
    const filters = { since: "2026-09-01T00:00:00.000Z", until: "2026-09-07T00:00:00.000Z" };
    useFiltersMock.mockReturnValue({ filters, dbRev: 7 });
    render(<OpponentsTab onOpen={() => {}} />);
    expect(useAllNetMmrOpponentsMock).toHaveBeenLastCalledWith(filters, 7);
    expect(useApiPaginatedMock.mock.lastCall?.[0]).toContain("since=2026-09-01");
    expect(useApiPaginatedMock.mock.lastCall?.[0]).toContain("until=2026-09-07");
    fireEvent.change(screen.getByRole("textbox", { name: "Search opponents" }), { target: { value: "papito" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter opponents by MMR impact" }), { target: { value: "net-loss" } });
    fireEvent.click(screen.getByRole("radio", { name: "20" }));
    // Nothing in the table survives these controls; the empty state
    // offers a way back from each local control.
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("No opponents match these filters")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Clear search" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Show all MMR impact" })).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /most net MMR won$/ })).getByText("+140")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /most net MMR lost$/ })).getByText("-130")).toBeTruthy();
  });

  it("updates grouped leaders and pair counts when the time period changes", () => {
    mockGroupedImpacts();
    const { rerender } = render(<OpponentsTab onOpen={() => {}} />);
    const narrowerFilters = { since: "2026-09-05T00:00:00.000Z" };
    useFiltersMock.mockReturnValue({ filters: narrowerFilters, dbRev: 8 });
    useAllNetMmrOpponentsMock.mockReturnValue({
      ...useAllNetMmrOpponentsMock.mock.results[0].value,
      items: [{ ...impacts[0], pulseId: "stimpacker", toonHandle: "1-S2-1-1", pulseCharacterId: "1", netMmr: 12, pairs: 1, mmrWon: 12, mmrLost: 0 }],
    });
    rerender(<OpponentsTab onOpen={() => {}} />);
    expect(useAllNetMmrOpponentsMock).toHaveBeenLastCalledWith(narrowerFilters, 8);
    const card = screen.getByRole("button", { name: "Open StimPacker, most net MMR won" });
    expect(within(card).getByText("+12")).toBeTruthy();
    expect(within(card).getByText("1 verified pair")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /most net MMR lost$/ })).toBeNull();
  });

  it("keeps ungrouped leader cards authoritative when the client-side join is truncated", () => {
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
    fireEvent.click(screen.getByRole("switch", { name: "Group same player" }));

    expect(
      screen.getByRole("button", { name: "Open Beta, most net MMR lost" }),
    ).toBeTruthy();
    expect(screen.getByText(/Some MMR impact rows were omitted/i)).toBeTruthy();
  });

  it.each(["opponents", "impact"])("does not rank incomplete groups when %s pages are capped", (source) => {
    mockGroupedImpacts();
    const { rerender } = render(<OpponentsTab onOpen={() => {}} />);
    const hook = source === "opponents" ? useApiPaginatedMock : useAllNetMmrOpponentsMock;
    hook.mockReturnValue({ ...hook.mock.results[0].value, hitMaxPages: true });
    rerender(<OpponentsTab onOpen={() => {}} />);
    expect(screen.getByText(/Grouped MMR leaders need the complete opponent history/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /most net MMR (won|lost)$/ })).toBeNull();
  });

  it.each(["opponents", "impact", "links"])("waits for %s before showing grouped leaders", (source) => {
    mockGroupedImpacts();
    const { rerender } = render(<OpponentsTab onOpen={() => {}} />);
    const hook = source === "opponents" ? useApiPaginatedMock : source === "impact" ? useAllNetMmrOpponentsMock : useApiMock;
    hook.mockReturnValue({ ...hook.mock.results[0].value, isLoading: true });
    rerender(<OpponentsTab onOpen={() => {}} />);
    expect(screen.queryByRole("button", { name: /most net MMR (won|lost)$/ })).toBeNull();
    expect(screen.queryByText(/No verified opponent MMR pairs match/)).toBeNull();
  });

  it("does not show empty or ungrouped leaders when opponent history fails", () => {
    useApiPaginatedMock.mockReturnValue({
      items: [], isLoading: false, error: new Error("offline"), pagesFetched: 0, hitMaxPages: false,
    });
    render(<OpponentsTab onOpen={() => {}} />);
    const alerts = screen.getAllByRole("alert").map((alert) => alert.textContent);
    expect(alerts.some((text) => text?.includes("verified MMR impact is temporarily unavailable"))).toBe(true);
    expect(screen.queryByRole("button", { name: /most net MMR (won|lost)$/ })).toBeNull();
    expect(screen.queryByText(/No verified opponent MMR pairs match/)).toBeNull();
    // The list itself shows Retry, not "no opponents match".
    expect(screen.getByTestId("request-error")).toBeTruthy();
    expect(screen.queryByText("No opponents match these filters")).toBeNull();
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
    const mostLost = screen.getByRole("button", { name: "Open Beta, most net MMR lost" });
    expect(within(mostLost).getByText("-10")).toBeTruthy();
    expect(within(mostLost).getByText("5 verified pairs")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /most net MMR won$/ })).toBeNull();
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
    expect(cells).toHaveLength(10);
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
    expect(within(grouped).getByText("Confirmed as Strange")).toBeTruthy();
    expect(within(grouped).getByTitle("Confirmed by an admin").textContent).toBe("Confirmed as Strange");
    expect(within(grouped).queryByText("StaleName")).toBeNull();
    expect(within(grouped).getAllByRole("cell")[5].textContent).toBe("6");
    expect(within(grouped).getByRole("link", { name: "Visit Strange's Twitch channel" }).getAttribute("href")).toBe("https://www.twitch.tv/strange");
    expect(within(grouped).getByRole("link", { name: "Visit Strange's YouTube channel" })).toBeTruthy();
    fireEvent.click(within(grouped).getByRole("link", { name: `Open dossier for ${barcode}` }));
    expect(onOpen).toHaveBeenLastCalledWith("8703807");

    fireEvent.click(screen.getByRole("button", { name: "Show the 2 names this player uses" }));
    const expanded = within(table).getAllByRole("row").filter((row) => row.className.includes("bg-bg-elevated/40"));
    expect(expanded).toHaveLength(2);
    const source = expanded.find((row) => within(row).queryByText(barcode))!;
    expect(within(source).getByTitle("Confirmed by an admin")).toBeTruthy();
    expect(within(source).getByRole("link", { name: "Visit Strange's YouTube channel" })).toBeTruthy();
    expect(within(source).getAllByRole("cell")[5].textContent).toBe("3");

    fireEvent.click(screen.getByRole("switch", { name: "Group same player" }));
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    const separate = within(table).getByText(barcode).closest("tr")!;
    expect(within(separate).getByTitle("Confirmed by an admin")).toBeTruthy();
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

describe("opponents progressive list", () => {
  it("windows large lists, preserves the expanded window on refresh, and resets it for search", () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ ...opponents[0], pulseId: `p-${i}`, name: `Player ${i}` }));
    useApiPaginatedMock.mockReturnValue({ items: rows, isLoading: false, isRefreshing: false, isLoadingMore: true,
      isStale: false, error: null, pagesFetched: 1, hitMaxPages: false, mutate: vi.fn() });
    const view = render(<OpponentsTab onOpen={vi.fn()} />);
    const table = screen.getByRole("table", { name: "Opponent history" });
    expect(within(table).getAllByRole("row")).toHaveLength(101);
    const more = screen.getByRole("button", { name: "Show 100 more" });
    more.focus(); fireEvent.click(more);
    expect(document.activeElement).toBe(more);
    expect(within(table).getAllByRole("row")).toHaveLength(201);
    useApiPaginatedMock.mockReturnValue({ ...useApiPaginatedMock.mock.results.at(-1)!.value, items: [...rows], isRefreshing: true });
    view.rerender(<OpponentsTab onOpen={vi.fn()} />);
    expect(within(table).getAllByRole("row")).toHaveLength(201);
    expect(screen.getByText(/Updating…/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search opponents" }), { target: { value: "Player" } });
    expect(within(table).getAllByRole("row")).toHaveLength(101);
  });
});

describe("rivals and responsive opponent consumers", () => {
  it("opts into detail summaries only for a selected data column and preserves global scope", () => {
    useFiltersMock.mockReturnValue({ filters: { matchup: "PvT", season: "68" }, dbRev: 7 });
    render(<OpponentsTab />);
    const request = () => new URL(useApiPaginatedMock.mock.calls.at(-1)![0], "https://example.test");
    expect(request().searchParams.get("listDetails")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Region" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Scouting notes" }));
    expect(request().searchParams.get("listDetails")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Average game length" }));
    expect(request().searchParams.getAll("listDetails")).toEqual(["1"]);
    expect(request().searchParams.get("matchup")).toBe("PvT");
    expect(request().searchParams.get("season")).toBe("68");
    expect(within(screen.getByRole("table")).getByRole("columnheader", { name: /Average game length/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Average game length" }));
    expect(request().searchParams.get("listDetails")).toBeNull();
  });
  it("requests a hidden URL sort's values and leaves missing durations last in both directions", () => {
    useApiPaginatedMock.mockReturnValue({ items: [
      { ...opponents[0], duration: { sumSec: 0, samples: 1, averageSec: 0 } },
      { ...opponents[1], duration: { sumSec: 900, samples: 3, averageSec: 300 } },
      { ...opponents[0], pulseId: "missing", pulseCharacterId: "303", name: "Unknown duration" },
    ], isLoading: false });
    const location = { pathname: "/app/opponents", query: "sort=avgGameLength", replace: vi.fn(), prefetch: vi.fn(), navigate: vi.fn() };
    const view = render(<OpponentsTab location={location} />);
    const names = () => [...screen.getByRole("table").querySelectorAll("tbody tr")].map(row => row.querySelector("a")?.textContent);
    expect(names()).toEqual(["Beta", "Alpha", "Unknown duration"]);
    expect(useApiPaginatedMock.mock.calls.at(-1)![0]).toContain("listDetails=1");
    expect(screen.queryByRole("columnheader", { name: /Average game length/ })).toBeNull();
    view.rerender(<OpponentsTab location={{ ...location, query: "sort=avgGameLength&dir=asc" }} />);
    expect(names()).toEqual(["Alpha", "Beta", "Unknown duration"]);
  });
  it("exports scoped scalar details after opt-in without full logs or signed replay URLs", () => {
    useFiltersMock.mockReturnValue({ filters: { matchup: "PvT" }, dbRev: 7 });
    useApiPaginatedMock.mockReturnValue({ items: [{ ...opponents[0],
      latestGame: { gameId: "latest", date: "2026-10-24T12:00:00.000Z", map: "=HYPERLINK(secret)", result: "win", durationSec: 0,
        myBuild: "Blink", oppStrategy: "Bio", macroScore: 0, top3Leaks: ["Supply"], replayAvailable: true, replaySizeBytes: 10,
        signedUrl: "https://secret.example/replay", fullMacro: "private-raw-log" },
      duration: { sumSec: 300, samples: 2, averageSec: 150 },
    }], isLoading: false });
    render(<OpponentsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(downloadCsvMock.mock.calls.at(-1)![1]).not.toContain("Average game length (seconds)");
    fireEvent.click(screen.getByRole("checkbox", { name: "Average game length" }));
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    const csv = downloadCsvMock.mock.calls.at(-1)![1] as string;
    expect(csv).toContain("Average game length (seconds)");
    expect(csv).toContain("matchup=PvT&listDetails=1");
    expect(csv).toContain("'=HYPERLINK(secret)");
    expect(csv).not.toContain("secret.example");
    expect(csv).not.toContain("private-raw-log");
  });
  it("hides unmeasured/default impact and Pulse columns, and Reset restores column defaults", () => {
    useAllNetMmrOpponentsMock.mockReturnValue({ items: [], isLoading: false });
    render(<OpponentsTab />); const table = screen.getByRole("table");
    expect(within(table).queryByRole("columnheader", { name: /Last MMR|Net MMR|Pulse ID/ })).toBeNull();
    expect(table.style.minWidth).toBe("640px");
    fireEvent.click(screen.getByRole("checkbox", { name: "Last MMR" }));
    expect(within(table).getByRole("columnheader", { name: /Last MMR/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(within(table).queryByRole("columnheader", { name: /Last MMR/ })).toBeNull();
  });
  it("sorts primary race while grouped rows display every recorded race", () => {
    useApiPaginatedMock.mockReturnValue({ items: [{ ...opponents[0], race: "Z" }, { ...opponents[1], race: "P" }], isLoading: false });
    render(<OpponentsTab />); const table = screen.getByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: /Race/ }));
    expect(within(table).getAllByRole("row")[1].textContent).toContain("Alpha");
    fireEvent.click(within(table).getByRole("button", { name: /Race/ }));
    expect(within(table).getAllByRole("row")[1].textContent).toContain("Beta");
    expect(within(table).getByRole("img", { name: "Protoss" })).toBeTruthy();
    expect(within(table).getByRole("img", { name: "Zerg" })).toBeTruthy();
  });
  it("uses actual mobile dossier links with notes/disclosures/stars outside the anchor and the same Back flag", () => {
    vi.stubGlobal("matchMedia", () => ({ matches:true, addEventListener:vi.fn(), removeEventListener:vi.fn() }));
    useApiMock.mockReturnValue({ data: { links: { "101": { accountId:"one" }, "202": { accountId:"one" } } } });
    useApiPaginatedMock.mockReturnValue({ items: [{ ...opponents[0], race:"Z", notes:"Check the third" }, { ...opponents[1], race:"P" }], isLoading:false });
    const onOpen = vi.fn(); render(<OpponentsTab onOpen={onOpen} />);
    expect(screen.queryByRole("table")).toBeNull(); const cards = screen.getByRole("list", { name:"Opponent history" });
    const alias = within(cards).getByRole("button", { name:/Show the 2 names/ });
    expect(alias.closest("a")).toBeNull(); expect(within(cards).getByRole("button", { name:/Scouting note/ }).closest("a")).toBeNull();
    expect(within(cards).getByRole("button", { name:/Star Beta/ }).closest("a")).toBeNull();
    fireEvent.click(alias); expect(onOpen).not.toHaveBeenCalled(); expect(within(cards).getAllByRole("listitem")).toHaveLength(3);
    const link = cards.querySelector('a[href="/app/opponents/beta"]')!;
    fireEvent.click(link); expect(onOpen).toHaveBeenCalledWith("beta"); expect(sessionStorage.getItem("opponents:from-list")).toBe("1");
    fireEvent.change(screen.getByRole("combobox", { name:"Sort opponents" }), { target:{value:"name"} });
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name:"Sort opponents" }).value).toBe("name");
  });
  it("exports all1500 sorted matching rows rather than the logical window", () => {
    const rows = Array.from({length:1500},(_,i) => ({ ...opponents[0], pulseId:`p-${i}`, name:`Player ${String(i).padStart(4,"0")}` }));
    useApiPaginatedMock.mockReturnValue({ items:rows, isLoading:false, isLoadingMore:false });
    render(<OpponentsTab />); expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(101);
    fireEvent.click(screen.getByRole("button", { name:"Export CSV" }));
    expect(downloadCsvMock).toHaveBeenCalledTimes(1); const [filename,csv] = downloadCsvMock.mock.calls[0];
    expect(filename).toMatch(/^sc2tools-opponents-\d{4}-\d{2}-\d{2}\.csv$/); expect(csv).toContain("Player 1499"); expect(csv.split("\r\n")).toHaveLength(1504);
  });
  it("passes explicit recent counts to Hot rematch and keeps starred rivals separate from Regulars", () => {
    const lastPlayed = new Date().toISOString();
    useApiPaginatedMock.mockReturnValue({ items:[{ ...opponents[0], lastPlayed }, opponents[1]], isLoading:false });
    useRivalSummaryMock.mockReturnValue({ data:{ recentComplete:true, weekGames:{ alpha:2 }, rivals:[] }, loading:false });
    useRivalsMock.mockReturnValue({ keys:["solo:alpha"], loading:false, toggle:vi.fn() });
    render(<OpponentsTab />);
    expect(within(screen.getByRole("region", { name:"Rivalries" })).getByText("Hot rematch").parentElement?.textContent).toContain("Alpha");
    fireEvent.click(screen.getByRole("button", { name:"Rivals (1)" }));
    expect(screen.getByRole("region", { name:"Starred rivals" }).textContent).toContain("Alpha");
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name:"Regulars: 5+ games" }));
    expect(screen.queryByRole("region", { name:"Starred rivals" })).toBeNull();
  });
  it("uses onboarding only after an unfiltered owner existence check proves no recorded games", () => {
    useApiPaginatedMock.mockReturnValue({ items:[], isLoading:false });
    useRivalSummaryMock.mockReturnValue({ data:{ hasAnyGames:false, recentComplete:true, weekGames:{}, rivals:[] }, loading:false });
    const view = render(<OpponentsTab />); expect(screen.getByText("No games synced yet")).toBeTruthy();
    useRivalSummaryMock.mockReturnValue({ data:{ hasAnyGames:true, recentComplete:true, weekGames:{}, rivals:[] }, loading:false }); view.rerender(<OpponentsTab />);
    expect(screen.queryByText("No games synced yet")).toBeNull(); expect(screen.getByText("No opponents match these filters")).toBeTruthy();
  });
});
