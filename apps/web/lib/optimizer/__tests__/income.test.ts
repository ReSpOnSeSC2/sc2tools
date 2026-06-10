import { describe, expect, it } from "vitest";
import { resolveProfile } from "../patch/profiles";
import {
  baseMineralRate,
  createBase,
  geyserGasRate,
  integrateIncome,
  timeUntilAffordable,
  type EconomyState,
} from "../sim/income";

const profile = resolveProfile("5.0.16");
const eco = profile.economy;

function freshState(workers: number): EconomyState {
  const base = createBase(0, eco, true);
  base.mineralWorkers = workers;
  return { bases: [base], mules: [], minerals: 0, gas: 0, lastIntegrated: 0 };
}

describe("income model", () => {
  it("16 workers on 8 patches mine in the measured LotV band", () => {
    const state = freshState(16);
    const perMinute = baseMineralRate(state.bases[0], eco) * 60;
    expect(perMinute).toBeGreaterThan(850);
    expect(perMinute).toBeLessThan(1000);
  });

  it("17th..24th workers add only the marginal third-worker rate", () => {
    const at16 = baseMineralRate(freshState(16).bases[0], eco);
    const at17 = baseMineralRate(freshState(17).bases[0], eco);
    const at24 = baseMineralRate(freshState(24).bases[0], eco);
    const at30 = baseMineralRate(freshState(30).bases[0], eco);
    expect(at17 - at16).toBeCloseTo(eco.mineralRateThirdWorker, 5);
    expect(at24 - at16).toBeCloseTo(8 * eco.mineralRateThirdWorker, 5);
    // beyond 3-per-patch saturation, extra workers add nothing
    expect(at30).toBeCloseTo(at24, 5);
  });

  it("3 workers collect ~160-175 gas/min, rich geysers 1.5x", () => {
    const state = freshState(0);
    const geyser = state.bases[0].geysers[0];
    geyser.active = true;
    geyser.workers = 3;
    const perMinute = geyserGasRate(geyser, eco) * 60;
    expect(perMinute).toBeGreaterThan(160);
    expect(perMinute).toBeLessThan(175);
    geyser.rich = true;
    expect(geyserGasRate(geyser, eco) * 60).toBeCloseTo(perMinute * 1.5, 5);
  });

  it("integrates income piecewise and stops at depletion", () => {
    const state = freshState(16);
    state.bases[0].mineralRemaining = 100;
    integrateIncome(state, eco, 60);
    expect(state.minerals).toBeCloseTo(100, 5);
    expect(state.bases[0].mineralRemaining).toBeCloseTo(0, 5);
    expect(baseMineralRate(state.bases[0], eco)).toBe(0);
  });

  it("a MULE returns its full configured total over its lifetime", () => {
    const state = freshState(0);
    state.mules.push({ expiresAt: eco.muleDurationSec });
    integrateIncome(state, eco, eco.muleDurationSec + 10);
    expect(state.minerals).toBeCloseTo(eco.muleMineralsTotal, 1);
    expect(state.mules).toHaveLength(0);
  });

  it("computes exact affordability times from current rates", () => {
    const state = freshState(16);
    const rate = baseMineralRate(state.bases[0], eco);
    const at = timeUntilAffordable(state, eco, 0, 400, 0);
    expect(at).toBeCloseTo(400 / rate, 5);
    // gas with zero gas income is unreachable until a geyser activates
    expect(timeUntilAffordable(state, eco, 0, 0, 25)).toBe(Infinity);
  });
});
