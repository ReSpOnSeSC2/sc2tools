import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { GhostBuildWidget } from "../GhostBuildWidget";
import { encodeGhostTarget, GHOST_BUILD_VERSION } from "@/lib/ghostBuild";
import type {
  LiveGameEnvelope,
  LiveGamePayload,
  LiveGamePhase,
} from "@/components/overlay/types";

const TARGET = {
  v: GHOST_BUILD_VERSION,
  name: "PvZ 2 SG Void Ray",
  steps: [
    { supply: 14, t: 17, name: "Pylon" },
    { supply: 20, t: 90, name: "Stargate" },
    { supply: 28, t: 120, name: "FleetBeacon" },
    { supply: 34, t: 150, name: "VoidRay" },
  ],
} as const;

const GHOST_PARAM = encodeGhostTarget({
  ...TARGET,
  steps: [...TARGET.steps],
})!;

function envelope(
  phase: LiveGamePhase,
  displayTime?: number,
): LiveGameEnvelope {
  return {
    type: "liveGameState",
    phase,
    capturedAt: 1_700_000_000,
    gameKey: "game-1",
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

  it("shows the compact armed idle card between games", () => {
    render(
      <GhostBuildWidget live={null} liveGame={null} ghostParam={GHOST_PARAM} />,
    );
    expect(screen.getByText("Ghost Build")).toBeTruthy();
    expect(screen.getByText("armed")).toBeTruthy();
    expect(screen.getByText("PvZ 2 SG Void Ray")).toBeTruthy();
    expect(screen.getByText(/4 timed steps/)).toBeTruthy();
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
    expect(screen.getByText(/waiting for game/)).toBeTruthy();
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
    expect(screen.getByText("1:35")).toBeTruthy(); // header clock
    expect(screen.getByText(/14 Pylon/)).toBeTruthy(); // done, dim
    expect(screen.getByText(/20 Stargate/)).toBeTruthy(); // current
    expect(screen.getByText("+5s")).toBeTruthy(); // ≤5s → green band
    expect(screen.getByText(/28 Fleet Beacon/)).toBeTruthy();
    expect(screen.getByText(/34 Void Ray/)).toBeTruthy();
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
    expect(screen.getByText("1:55")).toBeTruthy();
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
    expect(screen.getByText("0:00")).toBeTruthy();
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
    expect(screen.getByText("0:00")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText("0:30")).toBeTruthy();
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
