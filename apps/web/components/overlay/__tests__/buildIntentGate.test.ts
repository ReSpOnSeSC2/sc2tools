import { describe, expect, it } from "vitest";
import {
  EMPTY_BUILD_INTENT_LEDGER,
  MAX_RANDOMIZER_HOLD_MS,
  RANDOMIZER_INTENT_WAIT_MS,
  parseOverlayBuildIntent,
  randomizerIntentGate,
  randomizerSpinDelayMs,
  randomizerWindowAnchor,
  recordBuildIntent,
} from "../buildIntentGate";
import type { RandomizerIntentGate } from "../types";

function gate(over: Partial<RandomizerIntentGate> = {}): RandomizerIntentGate {
  return { gameKey: "g1", seen: true, suppressRandomizer: false, holdDeadlineMs: 0, ...over };
}

describe("parseOverlayBuildIntent", () => {
  it("accepts the server's payload shape", () => {
    expect(parseOverlayBuildIntent({ gameKey: "a|b|1", suppressRandomizer: true, holdRemainingMs: 4200 }))
      .toEqual({ gameKey: "a|b|1", suppressRandomizer: true, holdRemainingMs: 4200 });
  });

  it("retains a bounded canonical pick through the ledger", () => {
    const randomizer = { key: "pvt-blink-stalkers", name: "Canonical build", source: "catalog" as const };
    const event = parseOverlayBuildIntent({ gameKey: "g1", holdRemainingMs: 0, randomizer });
    const ledger = recordBuildIntent(EMPTY_BUILD_INTENT_LEDGER, event!, 1000);
    expect(randomizerIntentGate(ledger, "g1")?.randomizer).toEqual(randomizer);
    expect(randomizerIntentGate(ledger, "g2")?.randomizer).toBeUndefined();
    expect(parseOverlayBuildIntent({ gameKey: "g1", randomizer: { ...randomizer, key: "x".repeat(201) } })?.randomizer).toBeUndefined();
    expect(parseOverlayBuildIntent({ gameKey: "g1", randomizer: { ...randomizer, source: "admin" } })?.randomizer).toBeUndefined();
  });

  it.each([null, undefined, "x", 3, [], {}, { gameKey: "" }, { gameKey: 7 }, { gameKey: "k".repeat(401) }])(
    "rejects an unusable payload (%j)",
    (msg) => {
      expect(parseOverlayBuildIntent(msg)).toBeNull();
    },
  );

  it("treats a missing or malformed hold as none and clamps it into range", () => {
    expect(parseOverlayBuildIntent({ gameKey: "g", suppressRandomizer: false })?.holdRemainingMs).toBe(0);
    expect(parseOverlayBuildIntent({ gameKey: "g", holdRemainingMs: Number.NaN })?.holdRemainingMs).toBe(0);
    expect(parseOverlayBuildIntent({ gameKey: "g", holdRemainingMs: "6000" })?.holdRemainingMs).toBe(0);
    expect(parseOverlayBuildIntent({ gameKey: "g", holdRemainingMs: -50 })?.holdRemainingMs).toBe(0);
    expect(parseOverlayBuildIntent({ gameKey: "g", holdRemainingMs: 9e9 })?.holdRemainingMs)
      .toBe(MAX_RANDOMIZER_HOLD_MS);
  });

  it("only suppresses on an explicit true", () => {
    expect(parseOverlayBuildIntent({ gameKey: "g", suppressRandomizer: "yes" })?.suppressRandomizer).toBe(false);
  });
});

describe("recordBuildIntent", () => {
  it("anchors the hold to the local receipt time", () => {
    const ledger = recordBuildIntent(
      EMPTY_BUILD_INTENT_LEDGER,
      { gameKey: "g1", suppressRandomizer: false, holdRemainingMs: 6_000 },
      1_000,
    );
    expect(ledger.get("g1")).toEqual({ suppressRandomizer: false, holdDeadlineMs: 7_000 });
  });

  it("records no deadline once the hold is released", () => {
    const held = recordBuildIntent(
      EMPTY_BUILD_INTENT_LEDGER,
      { gameKey: "g1", suppressRandomizer: false, holdRemainingMs: 6_000 },
      1_000,
    );
    const released = recordBuildIntent(held, { gameKey: "g1", suppressRandomizer: false, holdRemainingMs: 0 }, 2_000);
    expect(released.get("g1")).toEqual({ suppressRandomizer: false, holdDeadlineMs: 0 });
    // The previous ledger is not mutated.
    expect(held.get("g1")?.holdDeadlineMs).toBe(7_000);
  });

  it("keeps only the most recently updated games", () => {
    let ledger = EMPTY_BUILD_INTENT_LEDGER;
    for (let i = 0; i < 9; i += 1) {
      ledger = recordBuildIntent(ledger, { gameKey: `g${i}`, suppressRandomizer: false, holdRemainingMs: 0 }, i);
    }
    expect(ledger.size).toBe(8);
    expect(ledger.has("g0")).toBe(false);
    // Touching an old game refreshes it, so the next eviction skips it.
    ledger = recordBuildIntent(ledger, { gameKey: "g1", suppressRandomizer: true, holdRemainingMs: 0 }, 10);
    ledger = recordBuildIntent(ledger, { gameKey: "g9", suppressRandomizer: false, holdRemainingMs: 0 }, 11);
    expect(ledger.has("g1")).toBe(true);
    expect(ledger.has("g2")).toBe(false);
  });
});

describe("randomizerIntentGate", () => {
  const ledger = recordBuildIntent(
    EMPTY_BUILD_INTENT_LEDGER,
    { gameKey: "g1", suppressRandomizer: true, holdRemainingMs: 3_000 },
    100,
  );

  it("needs a real game key", () => {
    expect(randomizerIntentGate(ledger, null)).toBeNull();
  });

  it("reports unseen games as not yet known", () => {
    expect(randomizerIntentGate(ledger, "g2"))
      .toEqual({ gameKey: "g2", seen: false, suppressRandomizer: false, holdDeadlineMs: 0 });
  });

  it("carries a seen game's state", () => {
    expect(randomizerIntentGate(ledger, "g1"))
      .toEqual({ gameKey: "g1", seen: true, suppressRandomizer: true, holdDeadlineMs: 3_100 });
  });
});

describe("randomizerSpinDelayMs", () => {
  it("waits at most the bounded window for state that has not arrived", () => {
    expect(randomizerSpinDelayMs({ gate: gate({ seen: false }), phase: "match_loading", waitStartedAtMs: 1_000, nowMs: 1_400 }))
      .toBe(RANDOMIZER_INTENT_WAIT_MS - 400);
    expect(randomizerSpinDelayMs({ gate: null, phase: "match_loading", waitStartedAtMs: 1_000, nowMs: 2_500 })).toBe(0);
    expect(randomizerSpinDelayMs({ gate: null, phase: null, waitStartedAtMs: 1_000, nowMs: 9_000 })).toBe(0);
  });

  it("keeps the wait even once the match has started (reconnect replay)", () => {
    expect(randomizerSpinDelayMs({ gate: null, phase: "match_in_progress", waitStartedAtMs: 0, nowMs: 500 }))
      .toBe(RANDOMIZER_INTENT_WAIT_MS - 500);
  });

  it("spins straight away once state without a hold has arrived", () => {
    expect(randomizerSpinDelayMs({ gate: gate(), phase: "match_loading", waitStartedAtMs: 0, nowMs: 10 })).toBe(0);
  });

  it("blocks a suppressed game regardless of phase or hold", () => {
    for (const phase of ["match_loading", "match_started", "match_in_progress"] as const) {
      expect(randomizerSpinDelayMs({
        gate: gate({ suppressRandomizer: true, holdDeadlineMs: 5_000 }), phase, waitStartedAtMs: 0, nowMs: 9_000,
      })).toBeNull();
    }
  });

  it("holds during loading until the local deadline", () => {
    const held = gate({ holdDeadlineMs: 6_000 });
    expect(randomizerSpinDelayMs({ gate: held, phase: "match_loading", waitStartedAtMs: 0, nowMs: 2_000 })).toBe(4_000);
    expect(randomizerSpinDelayMs({ gate: held, phase: "match_loading", waitStartedAtMs: 0, nowMs: 6_000 })).toBe(0);
    expect(randomizerSpinDelayMs({ gate: held, phase: null, waitStartedAtMs: 0, nowMs: 3_000 })).toBe(3_000);
  });

  it.each(["match_started", "match_in_progress"] as const)("ends the hold at %s", (phase) => {
    expect(randomizerSpinDelayMs({ gate: gate({ holdDeadlineMs: 6_000 }), phase, waitStartedAtMs: 0, nowMs: 2_000 }))
      .toBe(0);
  });
});

describe("randomizerWindowAnchor", () => {
  it("anchors to the spin that actually ran for this match", () => {
    expect(randomizerWindowAnchor("game:g1", { triggerKey: "game:g1", startedAtMs: 7_000 }, gate()))
      .toEqual({ key: "game:g1", atMs: 7_000 });
  });

  it("anchors to a pending hold before the spin", () => {
    expect(randomizerWindowAnchor("game:g1", { triggerKey: "game:g0", startedAtMs: 1 }, gate({ holdDeadlineMs: 6_000 })))
      .toEqual({ key: "game:g1", atMs: 6_000 });
  });

  it("does not stretch the window for a game that will not spin or is not held", () => {
    expect(randomizerWindowAnchor("game:g1", null, gate({ suppressRandomizer: true, holdDeadlineMs: 6_000 }))).toBeNull();
    expect(randomizerWindowAnchor("game:g1", null, gate({ seen: false }))).toBeNull();
    expect(randomizerWindowAnchor("game:g1", null, gate())).toBeNull();
    expect(randomizerWindowAnchor("game:g1", null, null)).toBeNull();
  });

  it("never anchors Test fires or keyless starts", () => {
    expect(randomizerWindowAnchor("test:1", { triggerKey: "test:1", startedAtMs: 5 }, null)).toBeNull();
    expect(randomizerWindowAnchor(null, null, gate({ holdDeadlineMs: 6_000 }))).toBeNull();
  });
});
