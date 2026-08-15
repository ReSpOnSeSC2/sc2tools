import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OpeningUnitsOutcome,
  UnitRevealStyle,
} from "@/lib/randomizer/types";
import { UnitRandomizerStage } from "../UnitRandomizerStage";

vi.mock("@/components/randomizer/reveals/revealShared", async () => {
  const actual = await vi.importActual<
    typeof import("@/components/randomizer/reveals/revealShared")
  >("@/components/randomizer/reveals/revealShared");
  return { ...actual, useReducedMotion: () => true };
});

function outcome(style: UnitRevealStyle): OpeningUnitsOutcome {
  return {
    gateCount: 2,
    picks: ["stalker", "stalker"],
    style,
    pool: [
      { id: "zealot", weight: 1 },
      { id: "stalker", weight: 3 },
      { id: "sentry", weight: 1 },
      { id: "adept", weight: 1 },
    ],
    probabilities: [1 / 6, 3 / 6, 1 / 6, 1 / 6],
  };
}

describe("UnitRandomizerStage", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it.each([
    ["warp-gate", "Warp chambers"],
    ["psi-draft", "Holo draft"],
    ["power-surge", "Pylon circuit"],
  ] as const)("renders the %s mode with real SC2 portraits", (style, label) => {
    const onComplete = vi.fn();
    const { container } = render(
      <UnitRandomizerStage
        outcome={outcome(style)}
        spinId={1}
        matchupLabel="PvP"
        buildName="PvP - 2 Gate Expand"
        onComplete={onComplete}
      />,
    );
    act(() => vi.runOnlyPendingTimers());

    expect(screen.getByText(label)).toBeTruthy();
    expect(
      screen.getAllByText(/Opening pair selected: Gate 1 Stalker/i).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      container.querySelector('img[src="/icons/sc2/units/stalker.png"]'),
    ).toBeTruthy();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("renders duplicate two-Gate picks as two ordered result sockets", () => {
    render(
      <UnitRandomizerStage
        outcome={outcome("warp-gate")}
        spinId={2}
        matchupLabel="PvP"
        buildName="PvP - Proxy 2 Gate"
      />,
    );
    act(() => vi.runOnlyPendingTimers());
    expect(screen.getAllByText("Gate 1").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Gate 2").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Stalker").length).toBeGreaterThanOrEqual(2);
  });
});
