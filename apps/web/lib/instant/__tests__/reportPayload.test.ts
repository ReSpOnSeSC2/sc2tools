import { describe, expect, it } from "vitest";
import { parseInstantPayload } from "../reportPayload";

function parse(macroBreakdown: unknown) {
  return parseInstantPayload(JSON.stringify({ gameId: "g", date: "2026-10-18", result: "Victory", macroBreakdown }))?.macroBreakdown;
}

describe("instant casualty ledger", () => {
  it("preserves unavailable versus tracked with zero casualties", () => {
    expect(parse({})).not.toHaveProperty("casualty_events");
    expect(parse({ casualty_events: [] })?.casualty_events).toEqual([]);
  });

  it("keeps valid exact events", () => {
    const valid = { time: 120.25, owner: "opp", killer: "me", category: "workers", name: "Drone" };
    expect(parse({ casualty_events: [
      valid,
      { ...valid, killer: null, category: "units", name: "Baneling" },
    ] })?.casualty_events).toEqual([valid, { ...valid, killer: null, category: "units", name: "Baneling" }]);
  });

  it("omits the entire ledger if any row is invalid", () => {
    const valid = { time: 120.25, owner: "opp", killer: "me", category: "workers", name: "Drone" };
    for (const invalid of [
      null, true, [],
      { ...valid, time: -1 },
      { ...valid, time: 86_401 },
      { ...valid, time: null },
      { ...valid, time: true },
      { ...valid, time: "120" },
      { ...valid, owner: "neutral" },
      { ...valid, killer: 1 },
      { ...valid, category: "economy" },
      { ...valid, name: "" },
      { ...valid, name: "a".repeat(65) },
    ]) {
      expect(parse({ casualty_events: [valid, invalid] })).not.toHaveProperty("casualty_events");
      expect(parse({ casualty_events: [invalid] })).not.toHaveProperty("casualty_events");
    }
    expect(parse({ casualty_events: Array(20_001).fill(valid) })).not.toHaveProperty("casualty_events");
    expect(parse({ casualty_events: { rows: [valid] } })).not.toHaveProperty("casualty_events");
  });
});
