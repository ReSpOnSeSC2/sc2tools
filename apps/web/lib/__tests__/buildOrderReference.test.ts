import { describe, expect, it } from "vitest";
import { publicReferenceBuildOrder, readReferenceBuildOrder } from "../buildOrderReference";
const order = { v: 1, source: "game", sourceGameId: "private-game", steps: [{ t: null, supply: 14, supplyApprox: true, action: "Unknown action", note: "Shared step instruction" }] };
describe("reference-only display contract", () => {
  it("retains untimed rows, approximation and unknown actions without making rules", () => {
    expect(readReferenceBuildOrder(order)).toEqual(order);
    expect(readReferenceBuildOrder(order)).not.toHaveProperty("rules");
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
