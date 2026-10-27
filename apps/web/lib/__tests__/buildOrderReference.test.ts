import { describe, expect, it } from "vitest";
import { publicReferenceBuildOrder, readReferenceBuildOrder } from "../buildOrderReference";
import { referenceBuildOrderError } from "../buildOrderReferenceErrors";
const order = { v: 1, source: "game", sourceGameId: "private-game", steps: [{ t: null, supply: 14, supplyApprox: true, action: "Unknown action", note: "Shared step instruction" }] };
describe("reference-only display contract", () => {
  it("retains untimed rows, approximation and unknown actions without making rules", () => {
    expect(readReferenceBuildOrder(order)).toEqual(order);
    expect(readReferenceBuildOrder(order)).not.toHaveProperty("rules");
  });
  it("accepts opaque composite replay IDs without exposing them publicly", () => {
    const sourceGameId = "2026-10-25T22:51:33|Tester Ω|Eternity's Edge / LE|492";
    expect(readReferenceBuildOrder({ ...order, sourceGameId })?.sourceGameId).toBe(sourceGameId);
    expect(publicReferenceBuildOrder({ ...order, sourceGameId })).not.toHaveProperty("sourceGameId");
    expect(readReferenceBuildOrder({ ...order, sourceGameId: "💠".repeat(256) })).not.toBeNull();
  });
  it.each([" ", "\t", "a\nb", "a\u007fb", "a\u009fb", "a\u2028b", "💠".repeat(257)])("rejects invalid source metadata", sourceGameId => {
    expect(readReferenceBuildOrder({ ...order, sourceGameId })).toBeNull();
    expect(referenceBuildOrderError({ ...order, sourceGameId })).toContain("source replay ID");
  });
  it("identifies the failing row and field without blaming valid steps", () => {
    expect(referenceBuildOrderError({ ...order, steps: [order.steps[0], { ...order.steps[0], t: -1 }] })).toMatch(/^Step 2: use a valid m:ss/);
    expect(referenceBuildOrderError({ ...order, steps: [{ ...order.steps[0], supply: 1001 }] })).toContain("Step 1: use supply from 0 to 1,000");
    expect(referenceBuildOrderError({ ...order, steps: [{ ...order.steps[0], action: "" }] })).toContain("Step 1: enter an action");
    expect(referenceBuildOrderError({ ...order, steps: [{ ...order.steps[0], note: "x".repeat(141) }] })).toContain("Step 1: keep the note");
  });
  it("projects public steps without private provenance or unknown nested fields", () => {
    expect(publicReferenceBuildOrder({ ...order, privateNotes: "secret", steps: [{ ...order.steps[0], privateChild: { secret: true } }] }))
      .toEqual({ v: 1, source: "game", steps: order.steps });
  });
  it.each([
    { ...order, v: 2 }, { ...order, source: "external" }, { ...order, steps: Array(121).fill(order.steps[0]) },
    { ...order, steps: [{ ...order.steps[0], t: -1 }] }, { ...order, steps: [{ ...order.steps[0], t: 1.2 }] },
    { ...order, steps: [{ ...order.steps[0], supply: Infinity }] }, { ...order, steps: [{ ...order.steps[0], action: " " }] },
    { ...order, steps: [{ ...order.steps[0], action: "💠".repeat(81) }] }, { ...order, steps: [{ ...order.steps[0], note: "x".repeat(141) }] },
  ])("rejects invalid/capped reference data", input => { expect(readReferenceBuildOrder(input)).toBeNull(); });
});
