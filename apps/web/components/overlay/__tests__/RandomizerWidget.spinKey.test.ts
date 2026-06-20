import { describe, expect, it } from "vitest";
import { deriveSpinKey } from "../widgets/RandomizerWidget";
import type { LiveGameEnvelope, LiveGamePayload } from "../types";

function envelope(over: Partial<LiveGameEnvelope> = {}): LiveGameEnvelope {
  return { type: "liveGameState", phase: "match_loading", capturedAt: 0, ...over };
}

describe("deriveSpinKey", () => {
  it("returns null without a matchup", () => {
    expect(deriveSpinKey(null, { gameKey: "g1" }, null)).toBeNull();
  });

  it("spins on the agent's pre-game envelope (game start)", () => {
    const key = deriveSpinKey("TvZ", null, envelope({ gameKey: "alice-bob-100" }));
    expect(key).toBe("TvZ:alice-bob-100");
  });

  it("does NOT spin on a post-game payload carrying a result (game end)", () => {
    const live: LiveGamePayload = { gameKey: "cloud-xyz", result: "win" };
    expect(deriveSpinKey("TvZ", live, null)).toBeNull();
  });

  it("keys off the envelope, ignoring a coexisting post-game result", () => {
    const live: LiveGamePayload = { gameKey: "cloud-xyz", result: "loss" };
    const lg = envelope({ gameKey: "alice-bob-100", phase: "match_in_progress" });
    expect(deriveSpinKey("TvZ", live, lg)).toBe("TvZ:alice-bob-100");
  });

  it("does NOT spin on a lingering match_ended envelope (game end)", () => {
    // The socket only nulls ``liveGame`` on idle/menu, so a ``match_ended``
    // envelope keeps arriving with the SAME gameKey after the game is over.
    // Keying off it would re-spin at game end once the mid-match visibility
    // timer has unmounted the widget and reset the spin-dedupe ref.
    const lg = envelope({ gameKey: "alice-bob-100", phase: "match_ended" });
    expect(deriveSpinKey("TvZ", null, lg)).toBeNull();
  });

  it("does NOT spin on a match_ended envelope + post-game payload", () => {
    // The realistic game-end state: the post-game ``live`` (with a result)
    // and the lingering ``match_ended`` envelope coexist. Neither may
    // produce a spin key.
    const live: LiveGamePayload = { gameKey: "alice-bob-100", result: "win" };
    const lg = envelope({ gameKey: "alice-bob-100", phase: "match_ended" });
    expect(deriveSpinKey("TvZ", live, lg)).toBeNull();
  });

  it("spins on a pre-game live payload with no result (agent offline)", () => {
    expect(deriveSpinKey("TvZ", { gameKey: "cloud-xyz" }, null)).toBe(
      "TvZ:cloud-xyz",
    );
  });

  it("always spins on a Test fire, even when the sample carries a result", () => {
    const live: LiveGamePayload = { isTest: true, result: "win", matchup: "PvT" };
    expect(deriveSpinKey("PvT", live, null)).toBe("PvT:test:PvT");
  });

  it("starts once, then stays silent when that same game ends", () => {
    // Game start — the agent envelope drives the key.
    const startKey = deriveSpinKey("TvZ", null, envelope({ gameKey: "g-1" }));
    // Game end — envelope cleared, post-game card lands with a different
    // cloud-derived key AND a result. Must not produce a (new) spin key.
    const endKey = deriveSpinKey(
      "TvZ",
      { gameKey: "g-2-cloud", result: "win" },
      null,
    );
    expect(startKey).toBe("TvZ:g-1");
    expect(endKey).toBeNull();
  });
});
