import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE_ID,
  listProfiles,
  mergeLayer,
  resolveProfile,
} from "../patch/profiles";

describe("patch profile layering", () => {
  it("resolves the 5.0.16 profile with every patch-note change applied", () => {
    const p = resolveProfile("5.0.16");
    // Economy overhaul
    expect(p.starting.workers).toBe(8);
    expect(p.economy.patchCapacity).toEqual({ large: 1600, small: 1200 });
    expect(p.economy.geyserCapacity).toBe(2500);
    expect(p.economy.richGasMultiplier).toBe(1.5);
    // Town hall supply cuts
    expect(p.units.Nexus.providesSupply).toBe(13);
    expect(p.units.CommandCenter.providesSupply).toBe(13);
    expect(p.units.Hatchery.providesSupply).toBe(4);
    // Warpgate rework
    expect(p.upgrades.WarpGateResearch.researchedAt).toEqual(["Gateway"]);
    expect(p.mechanics.warpgate.gatewaySpeedMultiplier).toBe(1.35);
    expect(p.mechanics.warpgate.transformCost).toEqual({
      minerals: 50,
      gas: 50,
    });
    expect(p.mechanics.warpgate.warpInSec).toBe(3);
    expect(p.mechanics.warpgate.cooldowns.Stalker).toBe(22);
    expect(p.mechanics.warpgate.cooldowns.DarkTemplar).toBe(35);
    // Gateway unit timings
    expect(p.units.Zealot.buildTime).toBe(28);
    expect(p.units.Adept.buildTime).toBe(28);
    expect(p.units.Sentry.buildTime).toBe(24);
    expect(p.units.HighTemplar.buildTime).toBe(40);
    // Ghost nerfs
    expect(p.units.Ghost.supply).toBe(3);
    expect(p.units.Ghost.combat?.hp).toBe(100);
    // Carapace cost cuts
    expect(p.upgrades.ZergGroundCarapaceLevel1.minerals).toBe(100);
    expect(p.upgrades.ZergGroundCarapaceLevel3.gas).toBe(200);
  });

  it("keeps base-profile values where the delta is silent", () => {
    const p = resolveProfile("5.0.16");
    expect(p.units.Marine.buildTime).toBe(18);
    expect(p.units.Zergling.minerals).toBe(25);
    expect(p.units.SpawningPool.buildTime).toBe(46);
    expect(p.units.Pylon.providesSupply).toBe(8);
    expect(p.economy.muleMineralsTotal).toBe(225);
  });

  it("does not mutate the base profile when resolving a delta", () => {
    const base1 = resolveProfile("lotv-base");
    resolveProfile("5.0.16");
    const base2 = resolveProfile("lotv-base");
    expect(base1.starting.workers).toBe(12);
    expect(base2).toEqual(base1);
    expect(base2.units.Nexus.providesSupply).toBe(15);
    expect(base2.units.Hatchery.providesSupply).toBe(6);
  });

  it("applies a user delta on top of the resolved chain", () => {
    const p = resolveProfile("5.0.16", {
      starting: { workers: 10 },
      units: { Zealot: { minerals: 125 } },
    });
    expect(p.starting.workers).toBe(10);
    expect(p.units.Zealot.minerals).toBe(125);
    // untouched siblings survive the merge
    expect(p.units.Zealot.buildTime).toBe(28);
  });

  it("deletes keys via null leaves", () => {
    const merged = mergeLayer(
      { a: 1, nested: { keep: true, drop: 2 } },
      { nested: { drop: null } },
    ) as { a: number; nested: { keep: boolean; drop?: number } };
    expect(merged.a).toBe(1);
    expect(merged.nested.keep).toBe(true);
    expect("drop" in merged.nested).toBe(false);
  });

  it("throws on unknown profile ids", () => {
    expect(() => resolveProfile("5.0.99")).toThrow(/Unknown patch profile/);
  });

  it("rejects user deltas that break referential integrity", () => {
    expect(() =>
      resolveProfile("5.0.16", {
        units: {
          Zealot: { builtFrom: ["MoonBase"] },
        },
      }),
    ).toThrow(/unknown "MoonBase"/);
  });

  it("lists registered profiles with the live patch as default", () => {
    const ids = listProfiles().map((p) => p.id);
    expect(ids).toContain("lotv-base");
    expect(ids).toContain(DEFAULT_PROFILE_ID);
  });
});
