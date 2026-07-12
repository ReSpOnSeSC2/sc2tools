import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { GhostBuildWidget } from "../GhostBuildWidget";
import {
  assignGhostTarget,
  emptyGhostBuildConfig,
  encodeGhostBuildConfig,
  encodeGhostTarget,
  GHOST_BUILD_VERSION,
  type GhostTarget,
} from "@/lib/ghostBuild";
import type {
  LiveGameEnvelope,
  LiveGamePayload,
  LiveGamePhase,
} from "@/components/overlay/types";

const TARGET: GhostTarget = {
  v: GHOST_BUILD_VERSION,
  name: "PvZ 2 SG Void Ray",
  steps: [
    { supply: 14, t: 17, name: "Pylon" },
    { supply: 20, t: 90, name: "Stargate" },
    { supply: 28, t: 120, name: "FleetBeacon" },
    { supply: 34, t: 150, name: "VoidRay" },
  ],
};

const CONFIG = assignGhostTarget(emptyGhostBuildConfig(), "PvZ", TARGET);
const GHOST_PARAM = encodeGhostBuildConfig(CONFIG)!;
const LEGACY_PARAM = encodeGhostTarget(TARGET)!;

function envelope(
  phase: LiveGamePhase,
  displayTime?: number,
  opponentRace = "Zerg",
  gameKey = "game-1",
): LiveGameEnvelope {
  return {
    type: "liveGameState",
    phase,
    capturedAt: 1_700_000_000,
    gameKey,
    user: { name: "Streamer", race: "Protoss" },
    opponent: { name: "Opponent", race: opponentRace },
    players: [
      { name: "Streamer", type: "user", race: "Protoss", result: "Undecided" },
      { name: "Opponent", type: "user", race: opponentRace, result: "Undecided" },
    ],
    ...(displayTime !== undefined ? { displayTime } : {}),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("GhostBuildWidget", () => {
  it("renders nothing when no target is armed", () => {
    const { container } = render(
      <GhostBuildWidget live={null} liveGame={null} ghostParam={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for a malformed ?ghost= value", () => {
    const { container } = render(
      <GhostBuildWidget live={null} liveGame={null} ghostParam="!!garbage!!" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows a placement hint on a test fire with nothing armed", () => {
    const live = { isTest: true } as LiveGamePayload;
    render(<GhostBuildWidget live={live} liveGame={null} ghostParam={null} />);
    expect(screen.getByText("Ghost Build")).toBeTruthy();
    expect(screen.getByText("not armed")).toBeTruthy();
  });

  it("prompts a legacy single-build URL to migrate instead of applying it globally", () => {
    render(
      <GhostBuildWidget live={null} liveGame={null} ghostParam={LEGACY_PARAM} />,
    );
    expect(screen.getByText("Matchup setup required")).toBeTruthy();
    expect(screen.getByText(/one legacy build/i)).toBeTruthy();
  });

  it("shows the compact armed idle card between games", () => {
    render(
      <GhostBuildWidget live={null} liveGame={null} ghostParam={GHOST_PARAM} />,
    );
    expect(screen.getByText("Ghost Build")).toBeTruthy();
    expect(screen.getByText("armed")).toBeTruthy();
    expect(screen.getByText("1 of 9 matchups ready")).toBeTruthy();
    expect(screen.getByText(/loading-screen races/i)).toBeTruthy();
  });

  it("falls back to the idle card once the match ends", () => {
    render(
      <GhostBuildWidget
        live={null}
        liveGame={envelope("match_ended", 600)}
        ghostParam={GHOST_PARAM}
      />,
    );
    expect(screen.getByText("armed")).toBeTruthy();
    expect(screen.getByText("1 of 9 matchups ready")).toBeTruthy();
  });

  it("coaches during a match: prev dim, current + next steps, green drift chip", () => {
    render(
      <GhostBuildWidget
        live={null}
        liveGame={envelope("match_in_progress", 95)}
        ghostParam={GHOST_PARAM}
      />,
    );
    // Clock 95 → Pylon (17) done, Stargate (90) current with +5s drift,
    // FleetBeacon/VoidRay up next.
    expect(screen.getByText("PvZ · 1:35")).toBeTruthy(); // matchup + clock
    expect(screen.getByText(/14 Pylon/)).toBeTruthy(); // done, dim
    expect(screen.getByText(/20 Stargate/)).toBeTruthy(); // current
    expect(screen.getByText("+5s")).toBeTruthy(); // ≤5s → green band
    expect(screen.getByText(/28 Fleet Beacon/)).toBeTruthy();
    expect(screen.getByText(/34 Void Ray/)).toBeTruthy();
  });

  it("shows a clear message when the exact matchup slot is empty", () => {
    render(
      <GhostBuildWidget
        live={null}
        liveGame={envelope("match_loading", undefined, "Terran")}
        ghostParam={GHOST_PARAM}
      />,
    );
    expect(screen.getByText("No build order configured for PvT")).toBeTruthy();
  });

  it("blocks Random opponents for the whole gameKey and resets on a new game", () => {
    const { rerender } = render(
      <GhostBuildWidget
        live={null}
        liveGame={envelope("match_loading", undefined, "Random", "random-game")}
        ghostParam={GHOST_PARAM}
      />,
    );
    expect(screen.getByText("No build order vs Random players")).toBeTruthy();

    rerender(
      <GhostBuildWidget
        live={null}
        liveGame={envelope("match_in_progress", 95, "Zerg", "random-game")}
        ghostParam={GHOST_PARAM}
      />,
    );
    expect(screen.getByText("No build order vs Random players")).toBeTruthy();

    rerender(
      <GhostBuildWidget
        live={null}
        liveGame={envelope("match_in_progress", 95, "Zerg", "new-game")}
        ghostParam={GHOST_PARAM}
      />,
    );
    expect(screen.queryByText("No build order vs Random players")).toBeNull();
    expect(screen.getByText("PvZ 2 SG Void Ray")).toBeTruthy();
  });

  it("advances the clock locally at 1 Hz between envelopes", () => {
    render(
      <GhostBuildWidget
        live={null}
        liveGame={envelope("match_in_progress", 95)}
        ghostParam={GHOST_PARAM}
      />,
    );
    expect(screen.getByText("+5s")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    // 95 + 20 = 115 → drift on the 90s Stargate step is +25s (red band).
    expect(screen.getByText("+25s")).toBeTruthy();
    expect(screen.getByText("PvZ · 1:55")).toBeTruthy();
  });

  it("shows a countdown (no drift chip) before the first step's time", () => {
    render(
      <GhostBuildWidget
        live={null}
        liveGame={envelope("match_started", 5)}
        ghostParam={GHOST_PARAM}
      />,
    );
    expect(screen.getByText("in 12s")).toBeTruthy();
    expect(screen.queryByText(/\+\d+s/)).toBeNull();
  });

  it("treats the loading screen as clock 0", () => {
    render(
      <GhostBuildWidget
        live={null}
        liveGame={envelope("match_loading")}
        ghostParam={GHOST_PARAM}
      />,
    );
    expect(screen.getByText("PvZ · 0:00")).toBeTruthy();
    expect(screen.getByText("in 17s")).toBeTruthy();
  });

  it("derives the clock from wall time when displayTime is absent", () => {
    render(
      <GhostBuildWidget
        live={null}
        liveGame={envelope("match_in_progress")}
        ghostParam={GHOST_PARAM}
      />,
    );
    // First envelope observed = t0.
    expect(screen.getByText("PvZ · 0:00")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText("PvZ · 0:30")).toBeTruthy();
  });

  it("announces target completion after the last step's time", () => {
    render(
      <GhostBuildWidget
        live={null}
        liveGame={envelope("match_in_progress", 400)}
        ghostParam={GHOST_PARAM}
      />,
    );
    expect(screen.getByText(/Target complete/)).toBeTruthy();
  });
});
