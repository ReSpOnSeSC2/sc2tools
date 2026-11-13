import { describe, expect, it } from "vitest";
import { balanceTierKey, balanceTierLabel, readBalanceBundle, selectBalanceTier } from "./bundle";
import { balanceBundleFixture } from "./fixture.test-data";

describe("readBalanceBundle", () => {
  it("orders a complete snapshot and defaults to Diamond 1", () => {
    const fixture = balanceBundleFixture();
    const decoded = readBalanceBundle({ ...fixture, tiers: [...fixture.tiers].reverse() });
    expect(decoded).toEqual(fixture);
    expect(balanceTierKey(selectBalanceTier(decoded!, "invalid")!)).toBe("diamond-1");
    expect(balanceTierLabel(selectBalanceTier(decoded!, "grandmaster")!)).toBe("Grandmaster");
  });

  it("rejects missing tiers, duplicate matchups, and impossible calendar dates", () => {
    const fixture = balanceBundleFixture();
    expect(readBalanceBundle({ ...fixture, tiers: fixture.tiers.slice(1) })).toBeNull();
    expect(readBalanceBundle({ ...fixture, asOf: "2026-02-30" })).toBeNull();
    const [first, ...rest] = fixture.tiers;
    expect(readBalanceBundle({ ...fixture, tiers: [first, first, ...rest.slice(1)] })).toBeNull();
    const matchups = [first.matchups[0], first.matchups[0], first.matchups[1]];
    expect(readBalanceBundle({ ...fixture, tiers: [{ ...first, matchups }, ...rest] })).toBeNull();
  });

  it("rejects impossible counts and keeps zero games distinct from a win rate", () => {
    const fixture = balanceBundleFixture();
    const first = fixture.tiers[0].matchups[0];
    expect(first.sameTier.winRate).toBeNull();
    expect(first.crossTier.winRate).toBe(0.405);
    first.sameTier.winRate = 0;
    expect(readBalanceBundle(fixture)).toBeNull();
    first.sameTier.winRate = null;
    first.crossTier.games = first.crossTier.wins - 1;
    expect(readBalanceBundle(fixture)).toBeNull();
    first.crossTier.games = 200;
    first.crossTier.interval = { low: 0.6, high: 0.7 };
    expect(readBalanceBundle(fixture)).toBeNull();
  });
});
