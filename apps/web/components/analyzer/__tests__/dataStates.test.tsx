/**
 * A failed request must show RequestError with Retry, never the view's
 * empty state ("no matchups match", "opponent not found"): on a single
 * free-tier API, cold starts and restarts are normal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const harness = vi.hoisted(() => ({
  useApi: vi.fn(),
  useApiPaginated: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock("@/lib/clientApi", () => ({ useApi: (...args: unknown[]) => harness.useApi(...args) }));
vi.mock("@/lib/useApiPaginated", () => ({
  useApiPaginated: (...args: unknown[]) => harness.useApiPaginated(...args),
}));
vi.mock("@/lib/netMmrOpponents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/netMmrOpponents")>()),
  useAllNetMmrOpponents: () => ({ items: [], summary: null, isLoading: false, error: null, hitMaxPages: false }),
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "owner-a", isLoaded: true, isSignedIn: true, getToken: async () => "t" }) }));
vi.mock("../usePlayerChannels", () => ({ usePlayerChannels: () => () => undefined }));
vi.mock("@/lib/useMyDisplayName", () => ({ useMyDisplayName: () => "Me" }));
// Panels with their own requests, covered elsewhere.
vi.mock("../mmr/StrategyMmrPanel", () => ({ StrategyMmrPanel: () => null }));
vi.mock("../mmr/BuildMatchupHeatmap", () => ({ BuildMatchupHeatmap: () => null }));
vi.mock("../MacroSummaryCard", () => ({ MacroSummaryCard: () => null }));
vi.mock("../maps/MapVetoPlanner", () => ({ MapVetoPlanner: () => null }));
vi.mock("@/lib/useSeasons", () => ({ useSeasons: () => ({ data: undefined }) }));

import { BattlefieldTab } from "../BattlefieldTab";
import { MacroTab } from "../MacroTab";
import { OpponentsTab } from "../OpponentsTab";
import { ProfileView } from "../ProfileView";
import { StrategiesTab } from "../StrategiesTab";

const SERVER_ERROR = {
  status: 500,
  code: "internal_error",
  message: "Something went wrong on our side. Try again in a moment.",
  requestId: "5f0c2a1e-1111-4222-8333-444455556666",
};

function failing(error: unknown = SERVER_ERROR) {
  return { data: undefined, error, isLoading: false, isValidating: false, mutate: harness.mutate };
}

beforeEach(() => {
  harness.mutate.mockReset();
  harness.mutate.mockResolvedValue(undefined);
  harness.useApi.mockReset();
  harness.useApi.mockImplementation(() => failing());
  harness.useApiPaginated.mockReset();
  window.localStorage.clear();
});

afterEach(cleanup);

async function pressFirstRetry() {
  await act(async () => {
    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
  });
}

describe("failed requests show Retry, not an empty state", () => {
  it("Battlefield: both cards", async () => {
    render(<BattlefieldTab />);
    expect(screen.getAllByTestId("request-error")).toHaveLength(2);
    expect(screen.queryByText(/match these filters/)).toBeNull();
    expect(screen.getAllByText(/Your filters are still applied\./)).toHaveLength(2);
    await pressFirstRetry();
    expect(harness.mutate).toHaveBeenCalledTimes(1);
  });

  it("Strategies: build vs strategy", async () => {
    render(<StrategiesTab />);
    expect(screen.getByText("My build × Their strategy")).toBeTruthy();
    expect(screen.getByTestId("request-error")).toBeTruthy();
    expect(screen.queryByText(/Not enough samples|match these filters/)).toBeNull();
    await pressFirstRetry();
    expect(harness.mutate).toHaveBeenCalled();
  });

  it("Strategies: by opponent strategy", async () => {
    render(<StrategiesTab />);
    fireEvent.click(screen.getByRole("button", { name: "By opponent strategy" }));
    expect(screen.getByText("Win rate vs opponent strategies")).toBeTruthy();
    expect(screen.getByTestId("request-error")).toBeTruthy();
    expect(screen.queryByText(/No strategies match/)).toBeNull();
    await pressFirstRetry();
    expect(harness.mutate).toHaveBeenCalled();
  });

  it("Macro: the report", async () => {
    render(<MacroTab />);
    expect(screen.getAllByTestId("request-error")).toHaveLength(2);
    expect(screen.queryByText("No scored games yet")).toBeNull();
    await pressFirstRetry();
    expect(harness.mutate).toHaveBeenCalledTimes(1);
  });

  it("Opponents: the list", async () => {
    const retry = vi.fn();
    harness.useApiPaginated.mockReturnValue({
      items: [],
      isLoading: false,
      error: { status: 0, code: "network_unavailable", message: "" },
      pagesFetched: 0,
      hitMaxPages: false,
      mutate: retry,
    });
    harness.useApi.mockImplementation(() => ({ data: undefined, isLoading: false }));
    render(<OpponentsTab onOpen={() => {}} />);
    expect(screen.getByText("Can't reach SC2 Tools")).toBeTruthy();
    expect(screen.queryByText("No opponents match these filters")).toBeNull();
    expect(screen.queryByRole("table", { name: "Opponent history" })).toBeNull();
    await pressFirstRetry();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("opponent dossier", () => {
  function mockProfile(response: object) {
    harness.useApi.mockImplementation((path: string | null) =>
      path && /^\/v1\/opponents\/[^/]+(\?|$)/.test(path) ? response : { data: undefined, isLoading: false },
    );
  }

  it("a 503 renders Retry, not 'not found'", async () => {
    mockProfile(failing({ status: 503, code: "opponent_profile_busy", message: "opponent profile analysis is busy" }));
    render(<ProfileView pulseId="2-S2-1-12345" onBack={() => {}} />);
    expect(screen.getByText("Analyzing… retrying")).toBeTruthy();
    expect(screen.queryByText(/couldn't find this opponent/i)).toBeNull();
    expect(screen.queryByText(/not found/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(harness.mutate).toHaveBeenCalledTimes(1);
  });

  it("a 5xx renders Retry too", () => {
    mockProfile(failing());
    render(<ProfileView pulseId="2-S2-1-12345" onBack={() => {}} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(/couldn't find this opponent/i)).toBeNull();
  });

  it("a 404 says the opponent isn't in your replays and links back", () => {
    mockProfile(failing({ status: 404, code: "not_found", message: "Not found." }));
    render(<ProfileView pulseId="2-S2-1-12345" onBack={() => {}} />);
    expect(screen.getByText("Not in your history")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to opponents" }).getAttribute("href")).toBe("/app/opponents");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("loads with a dossier-shaped skeleton", () => {
    mockProfile({ data: undefined, error: undefined, isLoading: true, mutate: harness.mutate });
    render(<ProfileView pulseId="2-S2-1-12345" onBack={() => {}} />);
    expect(screen.getByRole("status").textContent).toBe("Loading opponent dossier");
  });
});
