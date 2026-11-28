import { Profiler } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpeningUnitsOutcome, UnitRevealStyle } from "@/lib/randomizer/types";
import { UNIT_EXIT_MS, UNIT_RESULT_HOLD_MS } from "../RandomizerSequence";
import { UnitRandomizerStage } from "../UnitRandomizerStage";
import { HOLO_DRAFT_DURATION_MS } from "../unit-reveals/HoloDraftReveal";
import { POWER_SURGE_DURATION_MS } from "../unit-reveals/PowerSurgeReveal";
import { WARP_GATE_DURATION_MS } from "../unit-reveals/WarpGateChambersReveal";

vi.mock("../reveals/revealSound", () => ({ useRevealSound: vi.fn() }));

/** The candidate cycler ticks every 105 ms, so 4.65 s of cycling is ~44 commits. */
const CYCLE_COMMITS_PER_SECOND = 1000 / 105;

const DURATIONS: Record<UnitRevealStyle, number> = {
  "warp-gate": WARP_GATE_DURATION_MS,
  "psi-draft": HOLO_DRAFT_DURATION_MS,
  "power-surge": POWER_SURGE_DURATION_MS,
};

function outcome(style: UnitRevealStyle): OpeningUnitsOutcome {
  return {
    gateCount: 2,
    picks: ["adept", "stalker"],
    style,
    pool: [
      { id: "zealot", weight: 1 },
      { id: "stalker", weight: 1 },
      { id: "sentry", weight: 1 },
      { id: "adept", weight: 1 },
    ],
    probabilities: [0.25, 0.25, 0.25, 0.25],
  };
}

/**
 * Advance in display-frame steps, each in its own act(), so every timer tick
 * gets its own React commit as it would in OBS (one big advance batches them).
 */
function playFor(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) {
    act(() => vi.advanceTimersByTime(Math.min(FRAME_MS, ms - elapsed)));
  }
}

const FRAME_MS = 16;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("opening-unit reveal render budget", () => {
  it.each(["warp-gate", "psi-draft", "power-surge"] as const)(
    "%s stops rendering once both Gateways are locked",
    (style) => {
      let commits = 0;
      const complete = vi.fn();
      render(
        <Profiler id="units" onRender={() => { commits += 1; }}>
          <UnitRandomizerStage
            outcome={outcome(style)}
            spinId={1}
            matchupLabel="PvP"
            buildName="PvP - 2 Gate Expand"
            onComplete={complete}
          />
        </Profiler>,
      );

      playFor(DURATIONS[style]);
      expect(complete).toHaveBeenCalledTimes(1);
      const revealCommits = commits;
      expect(revealCommits).toBeLessThanOrEqual(
        Math.ceil((DURATIONS[style] / 1000) * CYCLE_COMMITS_PER_SECOND) + 4,
      );

      // The sequence keeps the result on screen for the hold and the exit.
      playFor(UNIT_RESULT_HOLD_MS + UNIT_EXIT_MS);
      expect(commits - revealCommits).toBe(0);
    },
  );
});
