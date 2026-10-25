import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpinOutcome } from "@/lib/randomizer/types";
import type { RevealProps } from "../reveals/revealShared";

const capture = vi.hoisted(() => ({ props: [] as RevealProps[] }));
vi.mock("../reveals/FighterBrawlReveal", () => ({ FighterBrawlReveal: (props: RevealProps) => { capture.props.push(props); return null; } }));
vi.mock("../reveals/SumoShoveReveal", () => ({ SumoShoveReveal: (props: RevealProps) => { capture.props.push(props); return null; } }));
vi.mock("../reveals/HungrySwarmReveal", () => ({ HungrySwarmReveal: (props: RevealProps) => { capture.props.push(props); return null; } }));
vi.mock("../reveals/AsteroidLockReveal", () => ({ AsteroidLockReveal: (props: RevealProps) => { capture.props.push(props); return null; } }));
vi.mock("../reveals/HorseRaceReveal", () => ({ HorseRaceReveal: (props: RevealProps) => { capture.props.push(props); return null; } }));
vi.mock("../reveals/ClawMachineReveal", () => ({ ClawMachineReveal: (props: RevealProps) => { capture.props.push(props); return null; } }));
vi.mock("../reveals/WheelSpinReveal", () => ({ WheelSpinReveal: (props: RevealProps) => { capture.props.push(props); return null; } }));
vi.mock("../reveals/SlotMachineReveal", () => ({ SlotMachineReveal: (props: RevealProps) => { capture.props.push(props); return null; } }));
vi.mock("../reveals/CaseUnboxingReveal", () => ({ CaseUnboxingReveal: (props: RevealProps) => { capture.props.push(props); return null; } }));
import { RandomizerStage } from "../RandomizerStage";

function outcome(style: SpinOutcome["style"]): SpinOutcome {
  const pool = Array.from({ length: 80 }, (_, index) => ({
    id: `build-${index}`, name: `Build ${index}`, race: "Protoss" as const,
    source: "catalog" as const, weight: index + 1,
  }));
  return { style, pool, winner: pool[71], matchup: "PvT", probabilities: pool.map((build) => build.weight / 3240), openingUnits: null };
}

afterEach(() => { cleanup(); capture.props.length = 0; });

describe("bounded motion rendering with the original full draw", () => {
  it.each(["fighter", "sumo", "swarm", "asteroid", "race", "claw"] as const)("caps %s sprites and preserves odds, audio pool and stable identity", (style) => {
    const spin = outcome(style);
    const complete = vi.fn();
    const view = render(<RandomizerStage outcome={spin} spinId={19} onComplete={complete} />);
    const first = capture.props.at(-1)!;
    expect(first.pool).toBe(spin.pool);
    expect(first.probabilities).toBe(spin.probabilities);
    expect(first.winner).toBe(spin.winner);
    expect(first.winnerProbability).toBe(spin.probabilities[71]);
    expect(first.onComplete).toBe(complete);
    expect(first.visualPool).toHaveLength(12);
    expect(first.visualPool).toContain(spin.winner);
    expect(screen.getByRole("note").textContent).toContain("12 of 80 contenders shown");
    view.rerender(<RandomizerStage outcome={{ ...spin }} spinId={19} onComplete={complete} />);
    expect(capture.props.at(-1)!.visualPool).toBe(first.visualPool);
  });

  it.each(["wheel", "slot", "case"] as const)("leaves the %s visual distribution unchanged", (style) => {
    const spin = outcome(style);
    render(<RandomizerStage outcome={spin} spinId={2} />);
    const props = capture.props.at(-1)!;
    expect(props.pool).toBe(spin.pool);
    expect(props.probabilities).toBe(spin.probabilities);
    expect(props.visualPool).toBeUndefined();
    expect(screen.queryByRole("note")).toBeNull();
  });
});
