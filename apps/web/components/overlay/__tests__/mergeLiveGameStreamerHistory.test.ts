import { describe, expect, it } from "vitest";
import {
  mergeLiveGameStreamerHistory,
  type StickyStreamerHistory,
} from "../mergeLiveGameStreamerHistory";
import type { LiveGameEnvelope } from "../types";

function envelope(
  extra: Partial<LiveGameEnvelope> = {},
): LiveGameEnvelope {
  return {
    type: "liveGameState",
    phase: "match_in_progress",
    capturedAt: 1,
    gameKey: "shared-key",
    ...extra,
  };
}

describe("mergeLiveGameStreamerHistory", () => {
  it("keeps rich history across a partial tick for the same opponent", () => {
    const rich = mergeLiveGameStreamerHistory(
      envelope({
        opponent: { name: "Opponent A" },
        streamerHistory: {
          oppName: "opponent a",
          headToHead: { wins: 2, losses: 1 },
        },
      }),
      null,
    );
    const partial = mergeLiveGameStreamerHistory(
      envelope({ opponent: { name: "  OPPONENT A  " } }),
      rich.sticky,
    );

    expect(partial.envelope.streamerHistory?.oppName).toBe("opponent a");
    expect(partial.sticky).toEqual(rich.sticky);
  });

  it("does not merge cached history when an old agent reuses the key for a new opponent", () => {
    const sticky: StickyStreamerHistory = {
      gameKey: "shared-key",
      opponentName: "opponent a",
      streamerHistory: {
        oppName: "Opponent A",
        headToHead: { wins: 9, losses: 0 },
      },
    };
    const result = mergeLiveGameStreamerHistory(
      envelope({ opponent: { name: "Opponent B" } }),
      sticky,
    );

    expect(result.envelope.streamerHistory).toBeUndefined();
    expect(result.sticky).toBeNull();
  });

  it("does not merge cached history into an opponent-less partial tick", () => {
    const sticky: StickyStreamerHistory = {
      gameKey: "shared-key",
      opponentName: "opponent a",
      streamerHistory: {
        oppName: "Opponent A",
        headToHead: { wins: 9, losses: 0 },
      },
    };
    const result = mergeLiveGameStreamerHistory(envelope(), sticky);

    expect(result.envelope.streamerHistory).toBeUndefined();
    expect(result.sticky).toBe(sticky);
  });

  it("strips an enriched history block that contradicts the direct opponent", () => {
    const result = mergeLiveGameStreamerHistory(
      envelope({
        opponent: { name: "Opponent B" },
        streamerHistory: {
          oppName: "Opponent A",
          cheeseProbability: 0.9,
        },
      }),
      null,
    );

    expect(result.envelope.opponent?.name).toBe("Opponent B");
    expect(result.envelope.streamerHistory).toBeUndefined();
    expect(result.sticky).toBeNull();
  });

  it("strips enriched history when the direct opponent is missing", () => {
    const result = mergeLiveGameStreamerHistory(
      envelope({
        streamerHistory: {
          oppName: "Opponent A",
          cheeseProbability: 0.9,
        },
      }),
      null,
    );

    expect(result.envelope.streamerHistory).toBeUndefined();
    expect(result.sticky).toBeNull();
  });
});
