import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpinOutcome } from "@/lib/randomizer/types";
import { RevealFrame, type RevealProps } from "../reveals/revealShared";

const capture = vi.hoisted(() => ({ callbacks: [] as Array<(() => void) | undefined>, props: [] as RevealProps[] }));
function MockReveal(props: RevealProps) {
  capture.callbacks.push(props.onComplete); capture.props.push(props);
  return <RevealFrame><span>Reveal in progress</span></RevealFrame>;
}
vi.mock("../reveals/CaseUnboxingReveal", () => ({ CaseUnboxingReveal: (props: RevealProps) => <MockReveal {...props} /> }));
vi.mock("../reveals/SlotMachineReveal", () => ({ SlotMachineReveal: (props: RevealProps) => <MockReveal {...props} /> }));
vi.mock("../reveals/GachaSummonReveal", () => ({ GachaSummonReveal: (props: RevealProps) => <MockReveal {...props} /> }));
vi.mock("../reveals/BattleRoyaleReveal", () => ({ BattleRoyaleReveal: (props: RevealProps) => <MockReveal {...props} /> }));
vi.mock("../reveals/WheelSpinReveal", () => ({ WheelSpinReveal: (props: RevealProps) => <MockReveal {...props} /> }));
vi.mock("../reveals/FighterBrawlReveal", () => ({ FighterBrawlReveal: (props: RevealProps) => <MockReveal {...props} /> }));
vi.mock("../reveals/HorseRaceReveal", () => ({ HorseRaceReveal: (props: RevealProps) => <MockReveal {...props} /> }));
vi.mock("../reveals/SumoShoveReveal", () => ({ SumoShoveReveal: (props: RevealProps) => <MockReveal {...props} /> }));
vi.mock("../reveals/AsteroidLockReveal", () => ({ AsteroidLockReveal: (props: RevealProps) => <MockReveal {...props} /> }));
vi.mock("../reveals/HungrySwarmReveal", () => ({ HungrySwarmReveal: (props: RevealProps) => <MockReveal {...props} /> }));
vi.mock("../reveals/ClawMachineReveal", () => ({ ClawMachineReveal: (props: RevealProps) => <MockReveal {...props} /> }));
import { RandomizerStage } from "../RandomizerStage";

const styles: SpinOutcome["style"][] = ["case", "slot", "gacha", "battle", "wheel", "fighter", "race", "sumo", "asteroid", "swarm", "claw"];
function outcome(style: SpinOutcome["style"], second = false): SpinOutcome {
  const pool = [
    { id: "blink", name: "Blink", race: "Protoss" as const, source: "catalog" as const, weight: 1 },
    { id: "oracle", name: "Oracle", race: "Protoss" as const, source: "catalog" as const, weight: 3 },
  ];
  return { style, pool, winner: pool[second ? 1 : 0], probabilities: [0.25, 0.75], matchup: "PvT", openingUnits: null };
}
afterEach(() => { cleanup(); capture.callbacks.length = 0; capture.props.length = 0; });

describe("resolved build announcement", () => {
  it.each(styles)("announces the existing full-pool winner only after %s resolves", (style) => {
    const spin = outcome(style), complete = vi.fn();
    render(<RandomizerStage outcome={spin} spinId={1} onComplete={complete} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");
    expect(status.className).toBe("sr-only");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(status.parentElement?.classList.contains("rdz-frame")).toBe(true);
    const props = capture.props.at(-1)!;
    expect(props.pool).toBe(spin.pool); expect(props.probabilities).toBe(spin.probabilities);
    expect(props.winner).toBe(spin.winner); expect(props.winnerProbability).toBe(0.25);
    act(() => props.onComplete?.());
    expect(status.textContent).toBe("Build chosen: Blink, Rare, 25% chance");
    expect(complete).toHaveBeenCalledTimes(1);
    act(() => props.onComplete?.());
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("clears a resolved announcement immediately on the next spin and rejects old completion", () => {
    const complete = vi.fn();
    const view = render(<RandomizerStage outcome={outcome("case")} spinId={11} onComplete={complete} />);
    const oldComplete = capture.callbacks.at(-1)!;
    act(oldComplete);
    expect(screen.getByRole("status").textContent).toBe("Build chosen: Blink, Rare, 25% chance");
    view.rerender(<RandomizerStage outcome={outcome("wheel", true)} spinId={12} onComplete={complete} />);
    expect(screen.getByRole("status").textContent).toBe("");
    const currentComplete = capture.callbacks.at(-1)!;
    act(oldComplete);
    expect(screen.getByRole("status").textContent).toBe("");
    expect(complete).toHaveBeenCalledTimes(1);
    act(currentComplete);
    expect(screen.getByRole("status").textContent).toBe("Build chosen: Oracle, Common, 75% chance");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("rejects a delayed unresolved spin and forwards the current completion callback", () => {
    const first = vi.fn(), latest = vi.fn();
    const spin = outcome("case");
    const view = render(<RandomizerStage outcome={spin} spinId={21} onComplete={first} />);
    const oldComplete = capture.callbacks.at(-1)!;
    view.rerender(<RandomizerStage outcome={spin} spinId={22} onComplete={first} />);
    const currentComplete = capture.callbacks.at(-1)!;
    view.rerender(<RandomizerStage outcome={spin} spinId={22} onComplete={latest} />);
    act(oldComplete);
    expect(screen.getByRole("status").textContent).toBe(""); expect(first).not.toHaveBeenCalled();
    act(currentComplete);
    expect(screen.getByRole("status").textContent).toContain("Build chosen: Blink");
    expect(first).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledTimes(1);
  });
});
