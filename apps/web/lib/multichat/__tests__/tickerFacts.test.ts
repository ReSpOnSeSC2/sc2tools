import { describe, expect, it } from "vitest";
import { sanitizeTickerFacts } from "../useTickerFacts";
import { sanitizeEngagement } from "../useEngagementState";

describe("sanitizeTickerFacts", () => {
  it("keeps well-formed facts and drops junk", () => {
    const out = sanitizeTickerFacts({
      facts: [
        { id: "career-record", text: "CAREER: 10 W – 5 L" },
        { id: "", text: "no id" },
        { id: "no-text" },
        "not-an-object",
        { id: "long", text: "x".repeat(500) },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: "career-record", text: "CAREER: 10 W – 5 L" });
    expect(out[1].text).toHaveLength(200);
  });

  it("returns [] for malformed payloads", () => {
    expect(sanitizeTickerFacts(null)).toEqual([]);
    expect(sanitizeTickerFacts({ facts: "nope" })).toEqual([]);
    expect(sanitizeTickerFacts(undefined)).toEqual([]);
  });

  it("caps the pool at 60 entries", () => {
    const facts = Array.from({ length: 100 }, (_, i) => ({
      id: `f${i}`,
      text: `fact ${i}`,
    }));
    expect(sanitizeTickerFacts({ facts })).toHaveLength(60);
  });
});

describe("sanitizeEngagement — prediction lock + oracle recap", () => {
  it("carries locksAtMs through and defaults the recap", () => {
    const out = sanitizeEngagement({
      prediction: {
        gameKey: "g1",
        opponent: "X",
        tally: { win: 2, loss: 1 },
        locksAtMs: 1234567,
      },
    });
    expect(out.prediction?.locksAtMs).toBe(1234567);
    expect(out.oracleRecap).toEqual({ calls: 0, majorityRight: 0, last: null });
  });

  it("omits locksAtMs when absent (legacy windows never lock)", () => {
    const out = sanitizeEngagement({
      prediction: { gameKey: "g1", opponent: "X", tally: {} },
    });
    expect(out.prediction).toBeTruthy();
    expect("locksAtMs" in (out.prediction ?? {})).toBe(false);
  });

  it("sanitizes the oracle recap and rejects malformed last calls", () => {
    const out = sanitizeEngagement({
      oracleRecap: {
        calls: "19",
        majorityRight: 12.4,
        last: {
          opponent: "Printf",
          result: "win",
          majority: "win",
          pct: 68,
          wasRight: true,
        },
      },
    });
    expect(out.oracleRecap.calls).toBe(19);
    expect(out.oracleRecap.majorityRight).toBe(12);
    expect(out.oracleRecap.last).toEqual({
      opponent: "Printf",
      result: "win",
      majority: "win",
      pct: 68,
      wasRight: true,
    });
    const bad = sanitizeEngagement({
      oracleRecap: { calls: 3, majorityRight: 1, last: { result: "banana" } },
    });
    expect(bad.oracleRecap.last).toBeNull();
  });
});
