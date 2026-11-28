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
    race: "Protoss",
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

  it("speaks a Terran pair in its own words, with each unit's structure and no build", () => {
    const terran: OpeningUnitsOutcome = {
      race: "Terran", gateCount: 2, picks: ["reaper", "hellion"], style: "warp-gate",
      pool: [{ id: "reaper", weight: 1 }, { id: "hellion", weight: 1 }], probabilities: [0.5, 0.5],
    };
    render(<UnitRandomizerStage outcome={terran} spinId={3} matchupLabel="TvZ" buildName={null} />);
    act(() => vi.runOnlyPendingTimers());
    expect(screen.getByText("Drop pods")).toBeTruthy();
    expect(screen.getAllByText("Opening units for any build")).toHaveLength(1);
    expect(screen.queryByText(/Queued for/)).toBeNull();
    expect(screen.getByText("Barracks")).toBeTruthy();
    expect(screen.getByText("Factory")).toBeTruthy();
    expect(screen.queryByText(/Gate 1/)).toBeNull();
    expect(screen.getAllByText("Opening pair selected: Reaper, then Hellion.").length).toBeGreaterThanOrEqual(1);
  });

  it("fits a long Zerg list in one row of icon-and-odds chips, around a Zerg hub", () => {
    const ids = ["zergling", "queen", "baneling", "roach", "ravager", "hydralisk", "lurker", "mutalisk"] as const;
    const zerg = (style: UnitRevealStyle): OpeningUnitsOutcome => ({
      race: "Zerg", gateCount: 1, picks: ["queen"], style,
      pool: ids.map((id) => ({ id, weight: 1 })), probabilities: ids.map(() => 1 / 8),
    });
    const chips = render(<UnitRandomizerStage outcome={zerg("warp-gate")} spinId={4} matchupLabel="ZvT" buildName="ZvT - Mass Queen Defensive" />);
    expect(chips.container.querySelectorAll('[title="Hydralisk"]').length).toBe(1);
    expect(screen.getByText("Spawning pods")).toBeTruthy();
    chips.unmount();
    const surge = render(<UnitRandomizerStage outcome={zerg("power-surge")} spinId={5} matchupLabel="ZvT" buildName={null} />);
    act(() => vi.runOnlyPendingTimers());
    expect(screen.getByText("Creep pulse")).toBeTruthy();
    expect(surge.container.querySelector('img[src="/icons/sc2/buildings/hatchery.png"]')).toBeTruthy();
  });
});
