import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameDraw, OpeningUnitsOutcome } from "@/lib/randomizer/types";
import {
  BETWEEN_ACTS_MS,
  BUILD_EXIT_MS,
  BUILD_RESULT_HOLD_MS,
  RandomizerSequence,
  UNIT_EXIT_MS,
  UNIT_RESULT_HOLD_MS,
  loadUnitStage,
} from "../RandomizerSequence";

const revealMock = vi.hoisted(() => ({
  autoCompleteBuild: false,
  reducedMotion: false,
}));

vi.mock("@/components/randomizer/RandomizerStage", () => ({
  RandomizerStage: ({ onComplete }: { onComplete?: () => void }) => {
    if (revealMock.autoCompleteBuild) {
      revealMock.autoCompleteBuild = false;
      onComplete?.();
    }
    return <button type="button" onClick={onComplete}>complete build</button>;
  },
}));

vi.mock("@/components/randomizer/UnitRandomizerStage", () => ({
  UnitRandomizerStage: ({ onComplete, buildName }: { onComplete?: () => void; buildName: string | null }) => (
    <button type="button" onClick={onComplete}>complete units {buildName ?? "alone"}</button>
  ),
}));

vi.mock("@/components/randomizer/reveals/revealShared", () => ({
  useReducedMotion: () => revealMock.reducedMotion,
}));

const UNITS: OpeningUnitsOutcome = {
  race: "Protoss",
  gateCount: 2,
  picks: ["stalker", "sentry"],
  style: "warp-gate",
  pool: [
    { id: "stalker", weight: 1 },
    { id: "sentry", weight: 1 },
  ],
  probabilities: [0.5, 0.5],
};

function draw(withUnits = true, withBuild = true): GameDraw {
  const winner = {
    id: "blink",
    name: "PvP - 2 Gate Blink",
    race: "Protoss" as const,
    source: "catalog" as const,
    weight: 1,
  };
  return {
    matchup: "PvP",
    build: withBuild ? { matchup: "PvP", winner, style: "wheel", pool: [winner], probabilities: [1] } : null,
    units: withUnits ? UNITS : null,
  };
}

/** The unit reveal loads on demand; let its module resolve. */
async function unitStageLoaded() {
  await act(async () => {
    await loadUnitStage();
  });
}

describe("RandomizerSequence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    revealMock.autoCompleteBuild = false;
    revealMock.reducedMotion = false;
  });
  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("fully exits the build act before mounting the opening-unit act", async () => {
    render(<RandomizerSequence draw={draw()} spinId={1} />);
    fireEvent.click(screen.getByRole("button", { name: "complete build" }));

    act(() => vi.advanceTimersByTime(BUILD_RESULT_HOLD_MS - 1));
    expect(screen.queryByText(/complete units/)).toBeNull();
    expect(screen.getByText("complete build")).toBeTruthy();

    act(() => vi.advanceTimersByTime(1));
    expect(
      document.querySelector('[data-randomizer-phase="build-exit"]'),
    ).toBeTruthy();
    expect(screen.queryByText(/complete units/)).toBeNull();

    act(() => vi.advanceTimersByTime(BUILD_EXIT_MS + BETWEEN_ACTS_MS));
    await unitStageLoaded();
    expect(screen.queryByText("complete build")).toBeNull();
    expect(screen.getByText("complete units PvP - 2 Gate Blink")).toBeTruthy();
  });

  it("holds the unit result, exits, then clears the sequence", async () => {
    const onComplete = vi.fn();
    render(
      <RandomizerSequence draw={draw()} spinId={1} onComplete={onComplete} />,
    );
    fireEvent.click(screen.getByText("complete build"));
    act(() =>
      vi.advanceTimersByTime(
        BUILD_RESULT_HOLD_MS + BUILD_EXIT_MS + BETWEEN_ACTS_MS,
      ),
    );
    await unitStageLoaded();
    fireEvent.click(screen.getByText(/complete units/));

    act(() => vi.advanceTimersByTime(UNIT_RESULT_HOLD_MS));
    expect(
      document.querySelector('[data-randomizer-phase="unit-exit"]'),
    ).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(UNIT_EXIT_MS));
    expect(document.querySelector("[data-randomizer-phase]")).toBeNull();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("keeps the established single-act result when no unit roll is eligible", () => {
    render(<RandomizerSequence draw={draw(false)} spinId={1} />);
    fireEvent.click(screen.getByText("complete build"));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("complete build")).toBeTruthy();
    expect(screen.queryByText(/complete units/)).toBeNull();
  });

  it("opens on the unit act, with no build, when units are drawn alone", async () => {
    const onComplete = vi.fn();
    render(<RandomizerSequence draw={draw(true, false)} spinId={1} onComplete={onComplete} />);
    expect(document.querySelector('[data-randomizer-phase="units"]')).toBeTruthy();
    expect(screen.queryByText("complete build")).toBeNull();
    await unitStageLoaded();
    fireEvent.click(screen.getByText("complete units alone"));
    act(() => vi.advanceTimersByTime(UNIT_RESULT_HOLD_MS + UNIT_EXIT_MS));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("holds the unit act's height while its code loads, so nothing jumps", () => {
    render(<RandomizerSequence draw={draw(true, false)} spinId={1} />);
    const stage = document.querySelector<HTMLElement>('[data-randomizer-phase="units"]');
    expect(stage?.style.minHeight).toBe("320px");
  });

  it("does not clear a synchronous reduced-motion completion on mount", async () => {
    revealMock.reducedMotion = true;
    revealMock.autoCompleteBuild = true;
    render(<RandomizerSequence draw={draw()} spinId={1} />);

    act(() => vi.advanceTimersByTime(700));
    await unitStageLoaded();
    expect(screen.queryByText("complete build")).toBeNull();
    expect(screen.getByText(/complete units/)).toBeTruthy();
  });

  it("cleans up the previous run when spinId changes", () => {
    const { rerender } = render(
      <RandomizerSequence draw={draw()} spinId={1} />,
    );
    fireEvent.click(screen.getByText("complete build"));

    rerender(<RandomizerSequence draw={draw()} spinId={2} />);
    act(() => vi.advanceTimersByTime(60_000));

    expect(screen.getByText("complete build")).toBeTruthy();
    expect(screen.queryByText(/complete units/)).toBeNull();
  });
});
