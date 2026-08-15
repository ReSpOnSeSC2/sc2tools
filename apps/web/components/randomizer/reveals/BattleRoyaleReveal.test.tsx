import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RandomizerBuild } from "@/lib/randomizer/types";
import {
  BATTLE_ROYALE_MAX_CONTENDERS,
  BATTLE_ROYALE_MAX_DURATION_MS,
  BattleRoyaleReveal,
  battleRoyaleDurationMs,
  buildBattleRoyaleField,
} from "./BattleRoyaleReveal";

vi.mock("./revealSound", () => ({
  useRevealSound: () => undefined,
}));

function makePool(size: number): RandomizerBuild[] {
  return Array.from({ length: size }, (_, index) => ({
    id: `build-${index}`,
    name: `Build ${index}`,
    race: "Protoss" as const,
    source: "catalog" as const,
    weight: 1,
  }));
}

describe("BattleRoyaleReveal", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("caps a large visual field, deterministically, without replacing the winner", () => {
    const pool = makePool(80);
    const winner = pool[73];

    const first = buildBattleRoyaleField(pool, winner, 42);
    const second = buildBattleRoyaleField(pool, winner, 42);

    expect(first).toHaveLength(BATTLE_ROYALE_MAX_CONTENDERS);
    expect(first).toEqual(second);
    expect(first.filter((build) => build.id === winner.id)).toEqual([winner]);
    expect(first.every((build) => pool.includes(build))).toBe(true);
  });

  it("keeps the complete field when it already fits the visual cap", () => {
    const pool = makePool(BATTLE_ROYALE_MAX_CONTENDERS);

    expect(buildBattleRoyaleField(pool, pool[5], 3)).toEqual(pool);
  });

  it("labels a capped bracket as a visual subset of the full draw", () => {
    const pool = makePool(40);

    render(
      <BattleRoyaleReveal
        pool={pool}
        probabilities={pool.map(() => 1 / pool.length)}
        winner={pool[31]}
        winnerProbability={1 / pool.length}
        spinId={9}
        matchupLabel="PvT"
      />,
    );

    const note = screen.getByRole("note");
    expect(
      within(note).getByText("Visual bracket · 12 of 40 builds shown"),
    ).toBeTruthy();
    expect(
      within(note).getByText("Winner drawn from the full eligible pool"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("list", { name: "Battle Royale contenders" }))
        .getAllByRole("listitem"),
    ).toHaveLength(BATTLE_ROYALE_MAX_CONTENDERS);
  });

  it("completes the largest possible visual bracket in 5.55 seconds", () => {
    const pool = makePool(200);
    const onComplete = vi.fn();

    expect(BATTLE_ROYALE_MAX_DURATION_MS).toBe(5_550);
    expect(BATTLE_ROYALE_MAX_DURATION_MS).toBeLessThanOrEqual(10_000);
    expect(battleRoyaleDurationMs(1_000_000)).toBe(
      BATTLE_ROYALE_MAX_DURATION_MS,
    );

    render(
      <BattleRoyaleReveal
        pool={pool}
        probabilities={pool.map(() => 1 / pool.length)}
        winner={pool[177]}
        winnerProbability={1 / pool.length}
        spinId={15}
        matchupLabel="PvZ"
        onComplete={onComplete}
      />,
    );

    act(() => vi.advanceTimersByTime(BATTLE_ROYALE_MAX_DURATION_MS - 1));
    expect(onComplete).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
