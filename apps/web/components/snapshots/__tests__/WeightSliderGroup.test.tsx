import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { rebalance, WeightSliderGroup } from "../WeightSliderGroup";
import type { MetricKey } from "../shared/snapshotTypes";

afterEach(() => cleanup());

const METRICS: MetricKey[] = [
  "army_value",
  "army_supply",
  "workers",
  "bases",
  "production_capacity",
  "income_min",
  "income_gas",
  "tech_tier_reached",
  "tech_path_winrate",
  "composition_matchup",
];

const DEFAULT = {
  early: METRICS.reduce((acc, m) => ({ ...acc, [m]: 0.1 }), {} as Record<MetricKey, number>),
  mid: METRICS.reduce((acc, m) => ({ ...acc, [m]: 0.1 }), {} as Record<MetricKey, number>),
  late: METRICS.reduce((acc, m) => ({ ...acc, [m]: 0.1 }), {} as Record<MetricKey, number>),
};

describe("rebalance", () => {
  it("preserves sum=1 after moving one slider", () => {
    const w: Record<MetricKey, number> = { ...DEFAULT.mid };
    const next = rebalance(w, "army_value", 0.4);
    const total = METRICS.reduce((s, m) => s + next[m], 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-6);
    expect(next.army_value).toBeCloseTo(0.4, 5);
  });

  it("clamps to [0,1]", () => {
    const w: Record<MetricKey, number> = { ...DEFAULT.mid };
    const tooHigh = rebalance(w, "workers", 2);
    expect(tooHigh.workers).toBe(1);
  });
});

describe("WeightSliderGroup", () => {
  it("renders preset buttons and a phase tab strip", () => {
    render(
      <WeightSliderGroup
        defaultWeights={DEFAULT}
        value={DEFAULT}
        preset="default"
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /default/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /economy heavy/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /combat heavy/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^early$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^mid$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^late$/i })).toBeTruthy();
  });

  it("invokes onChange when a preset is picked", () => {
    const onChange = vi.fn();
    render(
      <WeightSliderGroup
        defaultWeights={DEFAULT}
        value={DEFAULT}
        preset="default"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /economy heavy/i }));
    expect(onChange).toHaveBeenCalled();
    const [_, name] = onChange.mock.calls[0];
    expect(name).toBe("economy_heavy");
  });
});
