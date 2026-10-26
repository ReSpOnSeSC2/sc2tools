import { describe, expect, it } from "vitest";
import { normalizeBuildEvents } from "./build-events";
import type { GameIntentState } from "./buildIntent";
import type { DossierAnalysis } from "./dossierTypes";
import { ownTimingContext, ownTimingDeltas } from "./buildTimingComparison";

const state = (patch: Partial<GameIntentState> = {}) => ({ gameId: "game-a", status: "none", applied: false,
  build: null, detected: { name: "PvZ - Stargate", key: "pvz-stargate", slug: null }, ...patch } as GameIntentState);
const analysis = (): DossierAnalysis => ({ matchupTimingsLegacy: { PvZ: { order: ["Stargate"], timings: {
  Stargate: { source: "build_log", medianSeconds: 300, sampleCount: 8 },
  SpawningPool: { source: "opp_build_log", medianSeconds: 90, sampleCount: 8 },
} } } });

describe("owner timing context", () => {
  it("uses the loaded exact build identity and the existing revision cache suffix", () => {
    expect(ownTimingContext(state(), "game-a", "Protoss", "z", 7)).toEqual({ path: "/v1/builds/PvZ%20-%20Stargate#7", matchup: "PvZ" });
    expect(ownTimingContext(state({ detected: { name: "Private name", key: "custom:my-private", slug: "my-private" } }), "game-a", "p", "Zerg", 2)).toEqual({ path: "/v1/custom-builds/my-private/matches#2", matchup: "PvZ" });
    expect(ownTimingContext(state({ detected: { name: "Legacy private build", key: "custom:2Rax_SCV.v1", slug: "2Rax_SCV.v1" } }), "game-a", "Terran", "Zerg", 2)).toEqual({ path: "/v1/custom-builds/2Rax_SCV.v1/matches#2", matchup: "TvZ" });
    expect(ownTimingContext(state({ status: "confirmed", applied: true, build: { source: "custom", slug: "my-checkin", key: "custom:my-checkin", name: "Declared" } }), "game-a", "P", "Z", 0)?.path).toBe("/v1/custom-builds/my-checkin/matches#0");
  });
  it("does not guess a same-name definition for deleted, unknown or stale intent data", () => {
    const context = (value: GameIntentState | undefined, id = "game-a", mine = "P") => ownTimingContext(value, id, mine, "Z", 0);
    expect(context(undefined)).toBeUndefined(); expect(context(state(), "game-b")).toBeUndefined();
    expect(context(state(), "game-a", "Random")).toBeUndefined();
    expect(context(state({ detected: { name: "Private name", key: null, slug: null } }))).toBeUndefined();
    expect(context(state({ detected: { name: "Private name", key: "custom:x", slug: "../other" } }))).toBeUndefined();
    expect(context(state({ detected: { name: "Invalid path", key: "custom:..", slug: ".." } }))).toBeUndefined();
    expect(context(state({ status: "confirmed", applied: true, build: { source: "custom", name: "Deleted", slug: "gone", key: "custom:gone", deleted: true } }))).toBeUndefined();
  });
  it("uses detection when a confirmed answer was not applied", () => {
    expect(ownTimingContext(state({ status: "confirmed", applied: false, build: { source: "catalog", name: "Other", key: "other", slug: null } }), "game-a", "P", "Z", 0)?.path).toBe("/v1/builds/PvZ%20-%20Stargate#0");
  });
});

describe("first construction timing comparisons", () => {
  it("compares only the first canonical owner building with the exact matchup sample", () => {
    const rows = normalizeBuildEvents([{ time: 450, name: "Stargate", category: "building" }, { time: 312, name: "Stargate", category: "building" },
      { time: 200, name: "Oracle", category: "unit" }, { time: 100, name: "SpawningPool", category: "building" }]);
    const deltas = ownTimingDeltas(rows, analysis(), "PvZ");
    expect([...deltas.keys()]).toEqual([rows[1].key]);
    expect(deltas.get(rows[1].key)).toMatchObject({ label: "+12s vs your median" });
    expect(deltas.get(rows[1].key)?.title).toContain("from 8 recorded timing observations");
    expect(ownTimingDeltas(rows, analysis(), "PvT").size).toBe(0);
  });
  it("keeps zero/same, earlier and unknown baselines distinct", () => {
    const rows = normalizeBuildEvents([{ time: 300, name: "Stargate", category: "building" }]);
    expect(ownTimingDeltas(rows, analysis(), "PvZ").get(rows[0].key)?.label).toBe("Same as your median");
    const early = normalizeBuildEvents([{ time: 288, name: "Stargate", category: "building" }]);
    expect(ownTimingDeltas(early, analysis(), "PvZ").get(early[0].key)?.label).toBe("−12s vs your median");
    const small = analysis(); small.matchupTimingsLegacy!.PvZ.timings.Stargate.sampleCount = 1;
    expect(ownTimingDeltas(rows, small, "PvZ").size).toBe(0);
    expect(ownTimingDeltas(rows, undefined, "PvZ").size).toBe(0);
  });
});
