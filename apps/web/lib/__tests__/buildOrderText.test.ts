import { describe, expect, it } from "vitest";
import { BUILD_ORDER_PASTE_MAX_CHARS, normalizeReferenceAction, parseBuildOrderText } from "../buildOrderText";
describe("deterministic build-order paste", () => {
  it.each([
    ["[0:18] Pylon", { t: 18, supply: null, action: "BuildPylon" }],
    ["13  0:18  Pylon", { t: 18, supply: 13, action: "BuildPylon" }],
    ["14 - Pylon", { t: null, supply: 14, action: "BuildPylon" }],
    ["0:18 Pylon", { t: 18, supply: null, action: "BuildPylon" }],
    ["[2:14] 29 Marine", { t: 134, supply: 29, action: "TrainMarine" }],
  ])("parses supported format %s", (text, step) => { expect(parseBuildOrderText(text as string).order?.steps).toEqual([step]); });
  it("preserves exact canonical aliases and normalizes icon/friendly names", () => {
    expect(normalizeReferenceAction("ResearchBlinkTech").action).toBe("ResearchBlinkTech");
    expect(normalizeReferenceAction("Spawning Pool").action).toBe("BuildSpawningPool");
    expect(normalizeReferenceAction("Baneling").action).toBe("MorphBaneling");
  });
  it("keeps unknown action text and supply-only timing warnings saveable", () => {
    const result = parseBuildOrderText("14 – Experimental opener", { race: "Zerg" });
    expect(result.order).toEqual({ v: 1, source: "paste", steps: [{ t: null, supply: 14, action: "Experimental opener" }] });
    expect(result.issues.map(issue => issue.kind)).toEqual(["warning", "warning"]);
  });
  it("retains source order and reports individual malformed lines without importing a partial order", () => {
    const result = parseBuildOrderText("[3:00] Stargate\r\n\r\ninvalid line\r\n1:90 Pylon\r\n0:18 Pylon");
    expect(result.order).toBeNull(); expect(result.steps.map(step => step.t)).toEqual([180, 18]);
    expect(result.issues.filter(issue => issue.kind === "error").map(issue => issue.line)).toEqual([3, 4]);
  });
  it("bounds text, nonempty lines and issue fanout even when every line is invalid", () => {
    expect(parseBuildOrderText("x".repeat(BUILD_ORDER_PASTE_MAX_CHARS + 1)).issues).toHaveLength(1);
    const result = parseBuildOrderText("invalid\n".repeat(1000)); expect(result.order).toBeNull(); expect(result.issues).toHaveLength(121);
    expect(parseBuildOrderText("[0:18] Pylon\n".repeat(121)).order).toBeNull();
  });
  it("rejects oversized clock/supply/actions and warns instead of blocking a different race", () => {
    for (const line of ["[1441:00] Pylon", "1001 0:18 Pylon", `[0:18] ${"x".repeat(81)}`]) expect(parseBuildOrderText(line).order).toBeNull();
    const result = parseBuildOrderText("0:18 Spawning Pool", { race: "Protoss" }); expect(result.order).not.toBeNull(); expect(result.issues[0].message).toContain("Zerg");
  });
});
