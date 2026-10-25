import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpinOutcome } from "@/lib/randomizer/types";
import { RandomizerStage } from "../RandomizerStage";
import { buildMotionVisualField, MOTION_REVEAL_MAX_CONTENDERS } from "../reveals/visualField";

vi.mock("../reveals/revealSound", () => ({ useRevealSound: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("motion reveal DOM budget", () => {
  it.each(["fighter", "sumo", "swarm", "asteroid", "race", "claw"] as const)(
    "keeps the real %s sprites and legend bounded for a large full draw",
    (style) => {
      const pool = Array.from({ length: 80 }, (_, index) => ({
        id: `build-${index}`, name: `Build ${index}`, race: "Protoss" as const,
        source: "catalog" as const, weight: index + 1,
      }));
      const winner = pool[71];
      const spin: SpinOutcome = {
        style, pool, winner, matchup: "PvZ", openingUnits: null,
        probabilities: pool.map((build) => build.weight / 3240),
      };
      const shown = buildMotionVisualField(pool, winner, 19);
      const hidden = pool.find((build) => !shown.includes(build))!;
      const view = render(<RandomizerStage outcome={spin} spinId={19} />);

      // Exercise real reveal components: both arena and legend must use the
      // bounded field, rather than merely receiving an unused visualPool prop.
      const sprites = view.container.querySelectorAll("img");
      expect(sprites.length).toBeGreaterThanOrEqual(MOTION_REVEAL_MAX_CONTENDERS);
      expect(sprites.length).toBeLessThanOrEqual(MOTION_REVEAL_MAX_CONTENDERS * 2 + 1);
      expect(screen.queryByText(hidden.name)).toBeNull();
      expect(screen.getAllByText(winner.name).length).toBeGreaterThan(0);
      expect(screen.getByRole("note").textContent).toContain("12 of 80 contenders shown");
      expect(spin.pool).toHaveLength(80);
      expect(spin.winner).toBe(winner);
    },
  );
});
