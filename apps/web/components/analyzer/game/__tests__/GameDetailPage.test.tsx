import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { MacroBreakdownData } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import { GameDetailPage } from "../GameDetailPage";
import type { GameSummary } from "../types";

const useApiMock = vi.fn();
vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

// next/image needs the Next runtime; a bare <img> is equivalent here.
vi.mock("next/image", () => ({
  default: (props: { src?: string; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={String(props.src ?? "")} alt={props.alt ?? ""} />
  ),
}));

// recharts' ResponsiveContainer observes its parent unconditionally;
// jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ||
  ResizeObserverStub;

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
});

const SLIM: GameSummary = {
  gameId: "g1",
  date: "2026-07-01T10:00:00Z",
  result: "Defeat",
  map: "Ephemeron",
  myRace: "Zerg",
  myBuild: "Roach Allin",
  myMmr: 4100,
  durationSec: 700,
  macroScore: 44,
  spq: 71,
  opponent: {
    displayName: "Foe",
    race: "Terran",
    mmr: 4200,
    strategy: "Terran - 2 Rax",
  },
};

const MACRO: MacroBreakdownData = {
  ok: true,
  macro_score: 44,
  race: "Zerg",
  game_length_sec: 700,
  raw: {
    sq: 71,
    supply_blocked_seconds: 40,
    supply_block_windows: [{ start: 222, end: 262, blocked_sec: 40 }],
    injects_actual: 10,
    injects_expected: 20,
    mineral_float_spikes: 2,
  },
  all_leaks: [],
  stats_events: [
    { time: 10, army_value: 0, minerals_current: 50, food_used: 13, food_made: 14 },
    { time: 300, army_value: 2000, minerals_current: 400, food_used: 90, food_made: 98 },
    { time: 330, army_value: 400, minerals_current: 600, food_used: 60, food_made: 98 },
    { time: 690, army_value: 350, minerals_current: 900, food_used: 55, food_made: 98 },
  ],
  opp_stats_events: [
    { time: 10, army_value: 0 },
    { time: 300, army_value: 1900 },
    { time: 330, army_value: 1750 },
    { time: 690, army_value: 2400 },
  ],
};

const BUILD_ORDER = {
  ok: true,
  game_id: "g1",
  my_build: "Roach Allin",
  my_race: "Zerg",
  opp_strategy: "Terran - 2 Rax",
  opponent: "Foe",
  opp_race: "Terran",
  map: "Ephemeron",
  result: "Defeat",
  events: [
    {
      time: 17,
      time_display: "0:17",
      name: "SpawningPool",
      display: "Spawning Pool",
      race: "Zerg",
      category: "building",
      tier: 1,
      is_building: true,
    },
  ],
  early_events: [],
  opp_events: [
    {
      time: 45,
      time_display: "0:45",
      name: "Barracks",
      display: "Barracks",
      race: "Terran",
      category: "building",
      tier: 1,
      is_building: true,
    },
  ],
  opp_early_events: [],
  my_status: "ok" as const,
  opp_status: "ok" as const,
};

function mockEndpoints({
  slim = SLIM,
  macro = MACRO,
  slimError,
}: {
  slim?: GameSummary;
  macro?: MacroBreakdownData | null;
  slimError?: { status: number; message: string };
} = {}) {
  useApiMock.mockImplementation((path: string | null) => {
    if (!path) return { data: undefined, error: undefined, isLoading: false };
    if (path === "/v1/games/g1") {
      return slimError
        ? { data: undefined, error: slimError, isLoading: false }
        : { data: slim, error: undefined, isLoading: false };
    }
    if (path === "/v1/games/g1/macro-breakdown") {
      return macro
        ? { data: macro, error: undefined, isLoading: false }
        : {
            data: undefined,
            error: { status: 404, message: "Not found." },
            isLoading: false,
          };
    }
    if (path === "/v1/games/g1/build-order") {
      return { data: BUILD_ORDER, error: undefined, isLoading: false };
    }
    return { data: undefined, error: undefined, isLoading: false };
  });
}

describe("GameDetailPage", () => {
  it("renders header, timeline, mechanics and the loss autopsy on a defeat", () => {
    mockEndpoints();
    render(<GameDetailPage gameId="g1" />);

    // Header facts.
    expect(screen.getByText("Defeat")).toBeTruthy();
    expect(screen.getByText("Ephemeron")).toBeTruthy();
    expect(screen.getByText("Roach Allin")).toBeTruthy();
    expect(screen.getByText("Terran - 2 Rax")).toBeTruthy();

    // Centerpiece timeline with scrubber + readout.
    expect(screen.getByTestId("interactive-timeline")).toBeTruthy();
    expect(screen.getByLabelText("Scrub game time")).toBeTruthy();
    expect(screen.getByTestId("timeline-readout")).toBeTruthy();

    // Mechanics: race-aware inject stat from the breakdown payload.
    expect(screen.getByTestId("mechanics-panel")).toBeTruthy();
    expect(screen.getByText("Inject Efficiency")).toBeTruthy();

    // Loss → autopsy visible with at least one clickable timestamp.
    expect(screen.getByTestId("loss-autopsy-card")).toBeTruthy();
    expect(screen.getByText("Why you lost")).toBeTruthy();
    expect(screen.getByText("Missed injects")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Jump timeline to 3:42" }),
    ).toBeTruthy();

    // Build orders, both sides.
    expect(screen.getByText("Spawning Pool")).toBeTruthy();
    expect(screen.getByText("Barracks")).toBeTruthy();
  });

  it("hides the autopsy on a win", () => {
    mockEndpoints({ slim: { ...SLIM, result: "Victory" } });
    render(<GameDetailPage gameId="g1" />);
    expect(screen.getByText("Victory")).toBeTruthy();
    expect(screen.queryByTestId("loss-autopsy-card")).toBeNull();
    expect(screen.queryByText("Why you lost")).toBeNull();
    // The slot degrades to a friendly note, never a blank cell.
    expect(screen.getByText(/You won this one/)).toBeTruthy();
  });

  it("uses replay build-order races for the exact Ghost matchup", () => {
    mockEndpoints({
      slim: {
        ...SLIM,
        myRace: "Protoss",
        opponent: { ...SLIM.opponent!, race: "Zerg" },
      },
    });
    render(<GameDetailPage gameId="g1" />);

    // BUILD_ORDER says Zerg vs Terran. Those replay-derived values must win
    // over the conflicting slim summary so the build cannot enter PvZ.
    expect(screen.getByRole("button", { name: "Save for ZvT" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save for PvZ" })).toBeNull();
  });

  it("degrades to build logs when the macro breakdown was never computed", () => {
    mockEndpoints({ macro: null });
    render(<GameDetailPage gameId="g1" />);
    // Timeline can't render without stats_events — explanatory empty state.
    expect(screen.getByText(/No timeline samples/i)).toBeTruthy();
    // Mechanics panel still shows what the slim row carries (SQ 71).
    expect(screen.getByTestId("mechanics-panel")).toBeTruthy();
    expect(screen.getByText("71")).toBeTruthy();
    // Build orders survive untouched.
    expect(screen.getByText("Spawning Pool")).toBeTruthy();
    expect(screen.getByText("Barracks")).toBeTruthy();
  });

  it("returns to the originating opponent dossier when context is present", () => {
    mockEndpoints();
    render(
      <GameDetailPage
        gameId="g1"
        opponentContext={{ pulseId: "1-S2-1-99", displayName: "Foe" }}
      />,
    );

    const back = screen.getByRole("link", { name: "Back to Foe" });
    expect(back.getAttribute("href")).toBe(
      "/app?tab=opponents&opponent=1-S2-1-99",
    );
  });

  it("shows a branded not-found state with a back link on 404", () => {
    mockEndpoints({ slimError: { status: 404, message: "Not found." } });
    render(<GameDetailPage gameId="g1" />);
    expect(screen.getByText("Game not found")).toBeTruthy();
    const back = screen.getByRole("link", { name: /back to dashboard/i });
    expect(back.getAttribute("href")).toBe("/app");
  });
});
