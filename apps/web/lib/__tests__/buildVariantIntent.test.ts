import { describe, expect, it } from "vitest";
import { BUILD_DEFINITIONS } from "../build-definitions";
import ids from "../buildVariantIds.generated.json";
import { buildVariantContinuationHref, knownBuildVariantId, publicBuildVariantIntent } from "../buildVariantIntent";
describe("public build variant continuation", () => {
  it("keeps its tiny allowlist in parity with every rendered catalog id", () => {
    expect(ids).toEqual([...new Set(BUILD_DEFINITIONS.map(row => row.id))].sort());
    for (const id of ids) expect(knownBuildVariantId(id)).toBe(id);
  });
  it.each(["", "unknown-build", "../app", "zerg-12-pool\n", "zerg-12-pool?admin=1", "a".repeat(161)])("rejects unknown/unsafe ids %s", value => {
    expect(knownBuildVariantId(value)).toBeNull();
  });
  it.each(["variant=zerg-12-pool&x=1", "variant=zerg-12-pool&variant=zerg-hatch-first", "variant=unknown-build", "variant=zerg-12-pool&race=Z", "q=pool"]) ("rejects an expanded public continuation %s", query => {
    expect(publicBuildVariantIntent(new URLSearchParams(query))).toBeNull();
  });
  it("round-trips only a catalog identity on the public path", () => {
    expect(buildVariantContinuationHref("zerg-12-pool")).toBe("/definitions?variant=zerg-12-pool");
    expect(publicBuildVariantIntent(new URLSearchParams("variant=zerg-12-pool"))).toBe("zerg-12-pool");
    expect(buildVariantContinuationHref("unknown")).toBe("/definitions");
  });
});
