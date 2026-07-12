import { describe, expect, it } from "vitest";
import type { LiveGameEnvelope } from "@/components/overlay/types";
import { resolveGhostLiveRaces } from "@/lib/ghostLiveMatchup";

function envelope(
  overrides: Partial<LiveGameEnvelope> = {},
): LiveGameEnvelope {
  return {
    type: "liveGameState",
    phase: "match_loading",
    capturedAt: 1_700_000_000,
    gameKey: "game-1",
    ...overrides,
  };
}

describe("resolveGhostLiveRaces", () => {
  it("uses player names rather than array order", () => {
    const result = resolveGhostLiveRaces(
      envelope({
        user: { name: "Streamer" },
        opponent: { name: "Opponent", race: "Terran" },
        players: [
          { name: "Opponent", type: "user", race: "Terran", result: "Undecided" },
          { name: "Streamer", type: "user", race: "Protoss", result: "Undecided" },
        ],
      }),
    );

    expect(result).toEqual({
      ownRace: "P",
      opponentRace: "T",
      opponentIsRandom: false,
      ownRaceIsRandom: false,
    });
  });

  it("falls back to Blizzard's local-player-first order", () => {
    const result = resolveGhostLiveRaces(
      envelope({
        players: [
          { name: "Me", type: "user", race: "Zerg", result: "Undecided" },
          { name: "Them", type: "user", race: "Protoss", result: "Undecided" },
        ],
      }),
    );

    expect(result.ownRace).toBe("Z");
    expect(result.opponentRace).toBe("P");
  });

  it("lets a direct Random opponent override concrete history", () => {
    const result = resolveGhostLiveRaces(
      envelope({
        opponent: { name: "Dice", race: "random" },
        players: [
          { name: "Me", type: "user", race: "Terran", result: "Undecided" },
          { name: "Dice", type: "user", race: "Random", result: "Undecided" },
        ],
        streamerHistory: { myRace: "Terran", oppRace: "Zerg" },
      }),
    );

    expect(result.opponentIsRandom).toBe(true);
    expect(result.opponentRace).toBeNull();
  });

  it("prefers the agent's explicit user race", () => {
    const result = resolveGhostLiveRaces(
      envelope({
        user: { name: "Streamer", race: "Terran" },
        opponent: { name: "Opponent", race: "Zerg" },
        players: [],
      }),
    );

    expect(result.ownRace).toBe("T");
    expect(result.opponentRace).toBe("Z");
  });

  it("uses enriched matchup history only when direct races are absent", () => {
    const result = resolveGhostLiveRaces(
      envelope({
        streamerHistory: { myRace: "Zerg", oppRace: "Terran" },
      }),
    );

    expect(result.ownRace).toBe("Z");
    expect(result.opponentRace).toBe("T");
  });

  it("waits on direct unknown races instead of guessing from history", () => {
    const result = resolveGhostLiveRaces(
      envelope({
        user: { name: "Streamer", race: "?" },
        opponent: { name: "Opponent", race: "unknown" },
        players: [
          { name: "Streamer", type: "user", race: "?", result: "Undecided" },
          { name: "Opponent", type: "user", race: "?", result: "Undecided" },
        ],
        streamerHistory: { myRace: "Protoss", oppRace: "Terran" },
      }),
    );

    expect(result.ownRace).toBeNull();
    expect(result.opponentRace).toBeNull();
    expect(result.opponentIsRandom).toBe(false);
  });

  it("does not replace a direct Random own race with history", () => {
    const result = resolveGhostLiveRaces(
      envelope({
        players: [
          { name: "Me", type: "user", race: "Random", result: "Undecided" },
          { name: "Them", type: "user", race: "Zerg", result: "Undecided" },
        ],
        streamerHistory: { myRace: "Protoss", oppRace: "Zerg" },
      }),
    );

    expect(result.ownRaceIsRandom).toBe(true);
    expect(result.ownRace).toBeNull();
  });
});
