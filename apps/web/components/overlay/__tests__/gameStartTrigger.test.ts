import { describe, expect, it } from "vitest";
import {
  gameKeyFromTriggerKey,
  gameStartTriggerKey,
  scoutingStartTriggerKey,
} from "../gameStartTrigger";
import type { LiveGameEnvelope, LiveGamePayload } from "../types";

function envelope(
  extra: Partial<LiveGameEnvelope> = {},
): LiveGameEnvelope {
  return {
    type: "liveGameState",
    phase: "match_loading",
    capturedAt: 100,
    gameKey: "match-one",
    ...extra,
  };
}

describe("gameStartTriggerKey", () => {
  it("keeps one start identity through phase, opponent, and history updates", () => {
    const first = gameStartTriggerKey(null, envelope());
    const identified = gameStartTriggerKey(null, envelope({
      phase: "match_started",
      capturedAt: 101,
      opponent: { name: "Opponent", race: "Zerg" },
      user: { race: "Protoss" },
    }));
    const enriched = gameStartTriggerKey(null, envelope({
      phase: "match_in_progress",
      capturedAt: 102,
      opponent: { name: "Opponent", race: "Zerg" },
      streamerHistory: {
        oppName: "Opponent",
        matchup: "PvZ",
        headToHead: { wins: 2, losses: 1 },
      },
    }));

    expect(first).toBe("game:match-one");
    expect(identified).toBe(first);
    expect(enriched).toBe(first);
    expect(gameStartTriggerKey(null, envelope({
      gameKey: "match-two",
    }))).not.toBe(first);
  });

  it("recovers the same identity after a temporary absence", () => {
    const first = gameStartTriggerKey(null, envelope());

    expect(gameStartTriggerKey(null, null)).toBeNull();
    expect(gameStartTriggerKey(null, envelope({
      phase: "match_in_progress",
      capturedAt: 105,
    }))).toBe(first);
  });

  it("gives each Test click its own identity without replacing the real match identity", () => {
    const match = envelope();
    const test: LiveGamePayload = {
      isTest: true,
      testNonce: "click-one",
      matchup: "PvZ",
      result: "win",
    };

    expect(gameStartTriggerKey(test, match)).toBe("test:click-one");
    expect(gameStartTriggerKey({ ...test, matchup: "PvT" }, match))
      .toBe("test:click-one");
    expect(gameStartTriggerKey({ ...test, testNonce: "click-two" }, match))
      .toBe("test:click-two");
    expect(gameStartTriggerKey(null, match)).toBe("game:match-one");
  });

  it("supports a resultless pregame payload when no live envelope is available", () => {
    const pregame: LiveGamePayload = {
      gameKey: "offline-match",
      matchup: "PvZ",
    };

    expect(gameStartTriggerKey(pregame, null)).toBe("game:offline-match");
    expect(gameStartTriggerKey({ ...pregame, result: "win" }, null))
      .toBeNull();
    expect(gameStartTriggerKey({ ...pregame, result: "loss" }, null))
      .toBeNull();
  });

  it.each(["match_ended", "menu", "idle"] as const)(
    "does not start from %s even when an old resultless payload remains",
    (phase) => {
      expect(gameStartTriggerKey(
        { gameKey: "older-match", matchup: "PvZ" },
        envelope({ phase }),
      )).toBeNull();
    },
  );

  it("uses the active envelope key while the previous result payload is being cleared", () => {
    expect(gameStartTriggerKey(
      { gameKey: "previous-match", matchup: "PvT", result: "loss" },
      envelope(),
    )).toBe("game:match-one");
  });
});

describe("scoutingStartTriggerKey", () => {
  it.each(["match_loading", "match_ended", "menu", "idle"] as const)(
    "waits during %s even with enriched or resultless payloads", (phase) => {
      expect(scoutingStartTriggerKey({ oppName: "Opponent" }, envelope({
        phase, opponent: { name: "Opponent" }, streamerHistory: { oppName: "Opponent" },
      }))).toBeNull();
    },
  );

  it("starts once gameplay identifies an opponent and ignores replays", () => {
    const match = envelope({ phase: "match_started", opponent: { name: "Opponent" } });
    expect(scoutingStartTriggerKey(null, match)).toBe("game:match-one");
    expect(scoutingStartTriggerKey(null, { ...match, phase: "match_in_progress" }))
      .toBe("game:match-one");
    expect(scoutingStartTriggerKey(null, { ...match, opponent: undefined })).toBeNull();
    expect(scoutingStartTriggerKey(null, { ...match, isReplay: true })).toBeNull();
  });

  it("keeps settings previews available during loading", () => {
    expect(scoutingStartTriggerKey({ isTest: true, testNonce: "preview" }, envelope()))
      .toBe("test:preview");
  });
});

describe("gameKeyFromTriggerKey", () => {
  it("returns the real match key behind a game start", () => {
    expect(gameKeyFromTriggerKey("game:Alice|Bob|1700000000000")).toBe("Alice|Bob|1700000000000");
  });

  it("has no match key for Test fires, keyless starts or no start", () => {
    expect(gameKeyFromTriggerKey("test:123")).toBeNull();
    expect(gameKeyFromTriggerKey("game:unkeyed")).toBeNull();
    expect(gameKeyFromTriggerKey(null)).toBeNull();
  });
});
