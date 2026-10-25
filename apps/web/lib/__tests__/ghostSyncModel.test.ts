import { describe, expect, it } from "vitest";
import cases from "./fixtures/ghost-config-parity.json";
import { normalizeSyncedGhostBuildConfig, readGhostPracticeCache, writeGhostPracticeCache } from "../ghostSyncModel";

describe("Ghost account model parity", () => {
  it.each(cases)("$name", ({ input, expected }) => expect(normalizeSyncedGhostBuildConfig(input)).toEqual(expected));
  it("bounds UTF-8 JSON while leaving compact legacy decoding independent", () => {
    expect(normalizeSyncedGhostBuildConfig({ v: 2, slots: {}, ignored: "界".repeat(22000) })).toBeNull();
    expect(normalizeSyncedGhostBuildConfig({ v: 2, slots: {}, ignored: BigInt(1) })).toBeNull();
  });
  it("keeps explicit empty account caches isolated by owner", () => {
    localStorage.clear();
    writeGhostPracticeCache("a", { v: 2, slots: {} });
    expect(readGhostPracticeCache("a")).toEqual({ v: 2, slots: {} });
    expect(readGhostPracticeCache("b")).toBeNull();
  });
  it("a late lower revision cannot replace the offline cache", () => {
    localStorage.clear();
    writeGhostPracticeCache("a", { v: 2, slots: {}, revision: 3 });
    writeGhostPracticeCache("a", { v: 2, slots: {}, revision: 1 });
    expect(readGhostPracticeCache("a")?.revision).toBe(3);
  });
});
