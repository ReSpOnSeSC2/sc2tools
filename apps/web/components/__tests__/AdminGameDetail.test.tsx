import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AdminGameDetail, type AdminGameDetailGame } from "@/app/admin/components/AdminGameDetail";

const useApiMock = vi.fn();
vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));
vi.mock("@/components/analyzer/charts/ResourcesOverTimeChart", () => ({
  ResourcesOverTimeChart: () => <div>Resource chart</div>,
}));
vi.mock("@/components/analyzer/charts/ChronoAllocationChart", () => ({
  ChronoAllocationChart: () => <div>Chrono chart</div>,
}));
vi.mock("@/components/analyzer/macro/ActiveArmyChart", () => ({
  ActiveArmyChart: () => <div>Army chart</div>,
}));

const game: AdminGameDetailGame = {
  gameId: "2025-11-25|opponent|Tourmaline LE|548",
  date: "2025-11-25T12:33:25Z",
  result: "Loss",
  myRace: "Terran",
  map: "Tourmaline LE",
  durationSec: 548,
  myMmr: 5030,
  macroScore: 74,
  opponent: { displayName: "Opponent", race: "Terran", mmr: null },
};

function resource(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn().mockResolvedValue(undefined),
    request: vi.fn(),
    ...overrides,
  };
}

let build = resource();
let macro = resource();
beforeEach(() => {
  build = resource({ data: { ok: true, events: [], opp_events: [] } });
  macro = resource({ error: { status: 404, code: "macro_not_computed" } });
  useApiMock.mockImplementation((path: string) => path.endsWith("/build-order") ? build : macro);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function show() {
  return render(<AdminGameDetail userId="owner/test" game={game} onBack={vi.fn()} />);
}

describe("AdminGameDetail replay availability", () => {
  it("explains a saved score with absent details without inventing an upload failure", () => {
    show();
    expect(screen.getByText("Macro 74")).toBeTruthy();
    expect(screen.getByText("Build steps unavailable")).toBeTruthy();
    expect(screen.getByText(/A saved macro score does not include the chart data/)).toBeTruthy();
    expect(screen.queryByText(/synced before the field existed/)).toBeNull();
    expect(screen.queryByText(/Once a game uploads/)).toBeNull();
  });

  it("shows storage failures as retryable errors and only retries reads for the selected owner", async () => {
    const error = { status: 503, code: "game_details_unavailable", message: "Try again in a moment." };
    build = resource({ error });
    macro = resource({ error });
    show();
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.queryByText(/no build steps are stored/)).toBeNull();
    expect(screen.queryByText(/A saved macro score/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry build order" }));
    await waitFor(() => expect(build.mutate).toHaveBeenCalledOnce());
    expect(macro.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry macro breakdown" }));
    await waitFor(() => expect(macro.mutate).toHaveBeenCalledOnce());
    expect(build.request).not.toHaveBeenCalled();
    expect(macro.request).not.toHaveBeenCalled();
    expect(useApiMock.mock.calls.map(([path]) => path)).toEqual([
      `/v1/admin/users/owner%2Ftest/games/${encodeURIComponent(game.gameId)}/build-order`,
      `/v1/admin/users/owner%2Ftest/games/${encodeURIComponent(game.gameId)}/macro-breakdown`,
    ]);
  });

  it("keeps a missing game distinct from missing analysis", () => {
    const error = { status: 404, code: "game_not_found", message: "Not found." };
    build = resource({ error });
    macro = resource({ error });
    show();
    expect(screen.getAllByText(/This game could not be found/)).toHaveLength(2);
    expect(screen.queryByText(/A saved macro score/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("renders available details and replaces the error after a successful reload", () => {
    macro = resource({ error: { status: 503, message: "Try again." } });
    const view = show();
    expect(screen.getByRole("button", { name: "Retry macro breakdown" })).toBeTruthy();
    build = resource({ data: { ok: true, events: [{ time: 12, name: "SupplyDepot", supply: 14 }] } });
    macro = resource({ data: { ok: true, game_length_sec: 548, stats_events: [] } });
    view.rerender(<AdminGameDetail userId="owner/test" game={game} onBack={vi.fn()} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Resource chart")).toBeTruthy();
    expect(screen.getByText("Army chart")).toBeTruthy();
    expect(screen.queryByText("Build steps unavailable")).toBeNull();
  });

  it("prevents duplicate retry clicks while the request is pending", () => {
    macro = resource({ error: { status: 503, message: "Try again." }, isValidating: true });
    show();
    expect((screen.getByRole("button", { name: "Retry macro breakdown" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
