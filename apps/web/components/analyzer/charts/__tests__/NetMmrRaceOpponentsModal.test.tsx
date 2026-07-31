import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetMmrRaceOpponentsModal } from "../NetMmrRaceOpponentsModal";

const useApiMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

vi.mock("@/lib/filterContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/filterContext")>();
  return {
    ...actual,
    useFilters: () => ({
      filters: { race: "P", opp_race: "Z", exclude_too_short: true },
      dbRev: 9,
    }),
  };
});

const rogue = {
  pulseId: "1-S2-1-101",
  pulseCharacterId: "101",
  toonHandle: "1-S2-1-101",
  name: "Rogue",
  displayName: "Rogue",
  opponentRace: "P" as const,
  netMmr: 38,
  mmrWon: 62,
  mmrLost: 24,
  pairs: 4,
  games: 4,
  wins: 3,
  losses: 1,
  winRate: 0.75,
  avgDelta: 9.5,
  firstPlayed: "2026-06-01T00:00:00.000Z",
  lastPlayed: "2026-07-01T00:00:00.000Z",
};

const maru = {
  ...rogue,
  pulseId: "1-S2-1-202",
  pulseCharacterId: "202",
  toonHandle: "1-S2-1-202",
  name: "Maru",
  netMmr: -51,
  mmrWon: 20,
  mmrLost: 71,
  wins: 1,
  losses: 3,
  winRate: 0.25,
  avgDelta: -12.75,
};

const response = {
  items: [rogue, maru],
  totalOpponents: 40,
  total: 83,
  limit: 25,
  offset: 0,
  summary: {
    netMmr: -13,
    mmrWon: 82,
    mmrLost: 95,
    pairs: 8,
    opponents: 2,
    mostMmrGainedFrom: rogue,
    mostMmrLostTo: maru,
  },
};

beforeEach(() => {
  useApiMock.mockReturnValue({ data: response, isLoading: false, error: null });
});

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
  vi.useRealTimers();
});

describe("NetMmrRaceOpponentsModal", () => {
  it("shows mutually exclusive net leaders alongside gross and record columns", () => {
    render(<NetMmrRaceOpponentsModal race="P" onClose={() => {}} />);

    expect(screen.getByRole("dialog", { name: "MMR by Protoss opponent" })).toBeTruthy();
    expect(screen.getByText("Most net MMR won from")).toBeTruthy();
    expect(screen.getByText("Most net MMR lost to")).toBeTruthy();
    expect(screen.getAllByText("Rogue").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Maru").length).toBeGreaterThan(0);

    const highlights = screen.getByRole("region", {
      name: "Matchup opponent highlights",
    });
    expect(within(highlights).getByText("+38")).toBeTruthy();
    expect(within(highlights).getByText("\u221251")).toBeTruthy();
    expect(within(highlights).queryByText("+62")).toBeNull();
    expect(within(highlights).queryByText("\u221271")).toBeNull();

    const table = screen.getByRole("table");
    expect(table.className).toContain("min-w-[620px]");
    expect(
      within(table).getAllByRole("columnheader").map((header) => header.textContent),
    ).toEqual(["Opponent", "Record", "Pairs", "Taken", "Lost", "Net"]);
    expect(within(table).getByText("+62")).toBeTruthy();
    expect(within(table).getByText("−71")).toBeTruthy();
    expect(within(table).getByText("75.0%", { exact: false })).toBeTruthy();

    const request = String(useApiMock.mock.calls.at(-1)?.[0]);
    expect(request).toContain("/v1/mmr-by-matchup/opponents?");
    expect(request).toContain("race=P");
    expect(request).toContain("opp_race=P");
    expect(request).not.toContain("opp_race=Z");
    expect(request).toContain("limit=25");
    expect(request).toContain("offset=0");
    expect(request).toContain("#9");
  });

  it("sends search, minimum-pair, ranking, and pagination controls to the API", () => {
    vi.useFakeTimers();
    render(<NetMmrRaceOpponentsModal race="P" onClose={() => {}} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search Protoss opponents" }), {
      target: { value: "barcode 101" },
    });
    act(() => vi.advanceTimersByTime(260));
    let request = String(useApiMock.mock.calls.at(-1)?.[0]);
    expect(request).toContain("search=barcode+101");

    fireEvent.change(screen.getByRole("combobox", { name: "Minimum MMR pairs" }), {
      target: { value: "5" },
    });
    request = String(useApiMock.mock.calls.at(-1)?.[0]);
    expect(request).toContain("min_pairs=5");

    fireEvent.change(screen.getByRole("combobox", { name: "Sort opponents" }), {
      target: { value: "net-worst" },
    });
    request = String(useApiMock.mock.calls.at(-1)?.[0]);
    expect(request).toContain("sort=net_mmr");
    expect(request).toContain("order=asc");

    fireEvent.click(screen.getByRole("button", { name: /Next/i }));
    request = String(useApiMock.mock.calls.at(-1)?.[0]);
    expect(request).toContain("offset=25");
  });

  it("renders a useful empty state and closes from the shared dialog control", () => {
    const onClose = vi.fn();
    useApiMock.mockReturnValue({
      data: { ...response, items: [], totalOpponents: 0, summary: { ...response.summary, opponents: 0, pairs: 0, mostMmrGainedFrom: null, mostMmrLostTo: null } },
      isLoading: false,
      error: null,
    });
    render(<NetMmrRaceOpponentsModal race="P" onClose={onClose} />);

    expect(screen.getByText("No opponents match these filters")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
