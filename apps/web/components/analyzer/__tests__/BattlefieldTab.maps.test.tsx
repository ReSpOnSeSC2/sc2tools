import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { BattlefieldTab } from "../BattlefieldTab";
const poolState = vi.hoisted(() => ({ fresh: false, aliases: false }));
const csvExport = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock("@/lib/csvExport", async original => ({ ...(await original<typeof import("@/lib/csvExport")>()), downloadCsv: csvExport.download }));

const mapMatchups = [
  {
    map: "Ancient Cistern",
    matchup: "vs Z",
    wins: 4,
    losses: 1,
    total: 5,
    winRate: 0.8,
    ratedGames: 5, ratedWins: 4, expectedWins: 2.5, winsAboveExpected: 1.5,
  },
  {
    map: "Ancient Cistern",
    matchup: "vs T",
    wins: 1,
    losses: 1,
    total: 2,
    winRate: 0.5,
    ratedGames: 2, ratedWins: 1, expectedWins: 1, winsAboveExpected: 0,
  },
  {
    map: "Ruby Rock",
    matchup: "vs P",
    wins: 2,
    losses: 3,
    total: 5,
    winRate: 0.4,
    ratedGames: 5, ratedWins: 2, expectedWins: 3, winsAboveExpected: -1,
  },
  {
    map: "Custom Practice Map",
    matchup: "vs P",
    wins: 3,
    losses: 0,
    total: 3,
    winRate: 1,
    ratedGames: 3, ratedWins: 3, expectedWins: 1, winsAboveExpected: 2,
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
    return { data: poolState.aliases ? [...mapMatchups, { map: "Ancient Cistern LE", matchup: "vs Z", wins: 1, losses: 1, total: 2, winRate: 0.5 }] : mapMatchups, isLoading: false };
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

vi.mock("@/lib/filterContext", async (original) => ({
  ...(await original<typeof import("@/lib/filterContext")>()),
  useFilters: () => ({ filters: {}, dbRev: 7 }),
  filtersToQuery: () => "?scope=all",
}));

vi.mock("@/lib/useLocalStorageState", async (original) => ({
  ...(await original<typeof import("@/lib/useLocalStorageState")>()),
  useLocalStoragePositiveInt: () => [3, vi.fn()],
}));
vi.mock("@/lib/useSeasons", () => ({ useSeasons: () => ({ data: poolState.fresh ? { mapPool: ["Ancient Cistern LE"], mapPoolSource: "persisted", mapPoolFetchedAt: Date.now() } : undefined }) }));
vi.mock("../maps/MapVetoPlanner", () => ({ MapVetoPlanner: () => null }));
vi.mock("../maps/MapGamesModal", () => ({ MapGamesModal: ({ drill }: { drill: { map: string; maps?: string[]; opponent?: string } | null }) => drill ? <div role="dialog" aria-label="Map games">{drill.map} {drill.opponent}<output aria-label="Exact map aliases">{JSON.stringify(drill.maps)}</output></div> : null }));

beforeEach(() => { poolState.fresh = false; poolState.aliases = false; csvExport.download.mockReset(); localStorage.clear(); window.history.replaceState(null, "", "/app/maps"); });

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
  vi.unstubAllGlobals();
});

it("exports visible matchup and map rows with their Min games scope", () => {
  render(<BattlefieldTab />);
  const exports = screen.getAllByRole("button", { name: /Export these rows as CSV/ });
  fireEvent.click(exports[0]);
  expect(csvExport.download.mock.calls[0][0]).toMatch(/^sc2tools-matchups-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(csvExport.download.mock.calls[0][1]).toContain("min games 3");
  expect(csvExport.download.mock.calls[0][1]).toContain("vs Z,4,1,5,0.8");
  fireEvent.click(exports[1]);
  const maps = csvExport.download.mock.calls[1][1];
  expect(maps).toContain('Ancient Cistern,"Overall (all cells');
  expect(maps).toContain("Ancient Cistern,vs Z,4,1,5,0.8");
  expect(maps).not.toContain("Ancient Cistern,vs T");
  expect(maps).not.toContain("Hidden Training Map");
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
  it("combines edition aliases once and drills the complete cohort represented by its record", () => {
    poolState.aliases = true; render(<BattlefieldTab />);
    expect(document.querySelectorAll("#map-ancientcistern")).toHaveLength(1);
    const group = screen.getByRole("button", { name: "View games on Ancient Cistern" }).closest("li")!;
    expect(within(group).getByText("6W")).toBeTruthy(); expect(within(group).getByText("3L")).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: "View vs Z games on Ancient Cistern" }));
    expect(screen.getByLabelText("Exact map aliases").textContent).toBe('["Ancient Cistern","Ancient Cistern LE"]');
  });

  it("defaults to a fresh current pool using edition matching and can show every map", () => {
    poolState.fresh = true; render(<BattlefieldTab />);
    expect(screen.getByRole("switch", { name: "Current ladder pool only" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: "View games on Ruby Rock" })).toBeNull();
    expect(screen.getByRole("button", { name: "View games on Ancient Cistern" })).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Current ladder pool only" }));
    expect(screen.getByRole("button", { name: "View games on Ruby Rock" })).toBeTruthy();
  });

  it("keeps map sorting across a remount and opens map/matchup samples", () => {
    const view = render(<BattlefieldTab />);
    fireEvent.change(screen.getByRole("combobox", { name: "Sort maps by" }), { target: { value: "total" } });
    view.unmount(); render(<BattlefieldTab />);
    expect((screen.getByRole("combobox", { name: "Sort maps by" }) as HTMLSelectElement).value).toBe("total");
    fireEvent.click(screen.getByRole("button", { name: "View vs Z games on Ancient Cistern" }));
    expect(screen.getByRole("dialog", { name: "Map games" }).textContent).toContain("Ancient Cistern Z");
  });

  it("honors a focus deep link through LE aliases, highlights its row and opens its games", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; }); vi.stubGlobal("cancelAnimationFrame", vi.fn());
    window.history.replaceState(null, "", "/app/maps?focus=Ancient%20Cistern%20LE");
    render(<BattlefieldTab />);
    expect(document.getElementById("map-ancientcistern")?.className).toContain("ring-2 ring-accent");
    expect(screen.getByRole("dialog", { name: "Map games" }).textContent).toContain("Ancient Cistern");
  });

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
    ).toEqual(["Map", "Win rate", "Games", "Wins", "Losses", "Vs expected"]);
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
      ["winsAboveExpected", "Ruby Rock"],
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
