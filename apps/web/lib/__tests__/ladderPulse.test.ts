import { describe, expect, it } from "vitest";
import type { MetaRow } from "../meta";
import {
  isFreshReplay,
  metaApiPath,
  metaSelectionForGame,
  mmrBandFor,
  patchEraForGame,
  personalFormForLatest,
  pickDailyReplay,
  pickMetaMover,
  pulseMatchup,
  pulseResult,
  recentPulseRecord,
  sortPulseGames,
  verifiedMmrDelta,
  type PulseGame,
} from "../ladderPulse";

const NOW = Date.parse("2026-07-18T16:00:00.000Z");

function game(
  gameId: string,
  date: string,
  patch: Partial<PulseGame> = {},
): PulseGame {
  return {
    gameId,
    date,
    result: "Victory",
    myRace: "Protoss",
    myLadderRace: "Protoss",
    myToonHandle: "1-S2-1-100",
    myMmrSource: "replay",
    myMmr: 4000,
    myBuild: "PvZ - Stargate",
    durationSec: 600,
    opponent: {
      pulseId: `opp-${gameId}`,
      displayName: `Opponent ${gameId}`,
      race: "Zerg",
      leagueId: 4,
      mmr: 4100,
      strategy: "ZvP - Roach Pressure",
    },
    ...patch,
  };
}

describe("ladder pulse replay facts", () => {
  it("sorts valid replay rows newest-first and drops invalid dates", () => {
    const rows = sortPulseGames([
      game("old", "2026-07-17T00:00:00.000Z"),
      game("bad", "not-a-date"),
      game("new", "2026-07-18T00:00:00.000Z"),
    ]);
    expect(rows.map((row) => row.gameId)).toEqual(["new", "old"]);
  });

  it("normalizes result aliases and concrete matchups", () => {
    expect(pulseResult("Victory")).toBe("win");
    expect(pulseResult("Loss")).toBe("loss");
    expect(pulseResult("draw")).toBe("tie");
    expect(pulseResult("unfinished")).toBe("unknown");
    expect(pulseMatchup(game("g", "2026-07-18T00:00:00.000Z"))).toBe(
      "PvZ",
    );
    expect(
      pulseMatchup(
        game("random", "2026-07-18T00:00:00.000Z", {
          myRace: "Random",
        }),
      ),
    ).toBeNull();
  });

  it("compares MMR only across verified rows for the same toon and queue race", () => {
    const rows = [
      game("latest", "2026-07-18T15:00:00.000Z", { myMmr: 4124 }),
      game("other-race", "2026-07-18T14:00:00.000Z", {
        myLadderRace: "Zerg",
        myMmr: 5000,
      }),
      game("other-toon", "2026-07-18T13:00:00.000Z", {
        myToonHandle: "2-S2-1-200",
        myMmr: 3800,
      }),
      game("team", "2026-07-18T12:30:00.000Z", {
        playerCount: 4,
        myMmr: 7000,
      }),
      game("custom", "2026-07-18T12:15:00.000Z", {
        isLadderGame: false,
        myMmr: 6000,
      }),
      game("unverified", "2026-07-18T12:00:00.000Z", {
        myMmrSource: "unavailable",
        myMmr: 9999,
      }),
      game("previous", "2026-07-18T11:00:00.000Z", { myMmr: 4101 }),
    ];
    expect(verifiedMmrDelta(rows)).toEqual({
      from: 4101,
      to: 4124,
      delta: 23,
      previousGameId: "previous",
    });
  });

  it("omits MMR movement when identity or replay provenance is missing", () => {
    expect(
      verifiedMmrDelta([
        game("latest", "2026-07-18T15:00:00.000Z", {
          myToonHandle: null,
        }),
        game("previous", "2026-07-18T14:00:00.000Z"),
      ]),
    ).toBeNull();
    expect(
      verifiedMmrDelta([
        game("latest", "2026-07-18T15:00:00.000Z", {
          myMmrSource: "unavailable",
        }),
        game("previous", "2026-07-18T14:00:00.000Z"),
      ]),
    ).toBeNull();
  });

  it("marks only genuinely recent replay timestamps as fresh", () => {
    expect(
      isFreshReplay(game("new", "2026-07-18T15:45:00.000Z"), NOW),
    ).toBe(true);
    expect(
      isFreshReplay(game("import", "2025-01-01T00:00:00.000Z"), NOW),
    ).toBe(false);
    expect(
      isFreshReplay(game("bad", "not-a-date"), NOW),
    ).toBe(false);
  });
});

describe("daily replay and personal form", () => {
  const rows = [
    game("g1", "2026-07-18T15:00:00.000Z"),
    game("g2", "2026-07-18T14:00:00.000Z", { result: "Defeat" }),
    game("g3", "2026-07-18T13:00:00.000Z"),
    game("g4", "2026-07-18T12:00:00.000Z", { result: "Tie" }),
  ];

  it("is stable within a day, excludes latest, and advances the next day", () => {
    const first = pickDailyReplay(rows, "user-1", "2026-07-18", "g1");
    const again = pickDailyReplay(rows, "user-1", "2026-07-18", "g1");
    const tomorrow = pickDailyReplay(rows, "user-1", "2026-07-19", "g1");
    expect(first?.gameId).toBe(again?.gameId);
    expect(first?.gameId).not.toBe("g1");
    expect(tomorrow?.gameId).not.toBe(first?.gameId);
  });

  it("reports exact recent W-L-T totals", () => {
    expect(recentPulseRecord(rows, 4)).toEqual({
      wins: 2,
      losses: 1,
      ties: 1,
      total: 4,
    });
  });

  it("bounds build form claims to the loaded replay window", () => {
    expect(personalFormForLatest(rows)).toEqual({
      kind: "build",
      label: "PvZ - Stargate",
      wins: 2,
      losses: 1,
      ties: 1,
      total: 4,
      windowGames: 4,
    });
  });

  it("never headlines an unclassified build — form falls back to the matchup", () => {
    const unclassified = rows.map((row) => ({
      ...row,
      myBuild: "PvZ - Macro Transition (Unclassified)",
    }));
    expect(personalFormForLatest(unclassified)).toEqual({
      kind: "matchup",
      label: "PvZ",
      wins: 2,
      losses: 1,
      ties: 1,
      total: 4,
      windowGames: 4,
    });
  });
});

describe("meta selection and movement", () => {
  it("prefers a valid league and falls back to exact published MMR bands", () => {
    const latest = game("g", "2026-07-18T15:00:00.000Z");
    expect(metaSelectionForGame(latest)).toEqual({
      axis: "league",
      band: 4,
      matchup: "PvZ",
      era: "after",
    });

    const mmrOnly = game("mmr", "2026-07-18T15:00:00.000Z", {
      opponent: {
        race: "Terran",
        leagueId: null,
        mmr: 5342,
      },
    });
    expect(metaSelectionForGame(mmrOnly)).toEqual({
      axis: "mmr",
      band: 5000,
      matchup: "PvT",
      era: "after",
    });
    expect(mmrBandFor(1999)).toBe(1000);
    expect(mmrBandFor(6500)).toBe(6500);
    expect(mmrBandFor(null)).toBeNull();
  });

  it("uses exact replay provenance for patch era and skips non-ladder meta", () => {
    const beforeByBuild = game("old-build", "2026-07-18T15:00:00.000Z", {
      gameBuild: 97_363,
    });
    const afterByVersion = game(
      "new-version",
      "2026-01-01T15:00:00.000Z",
      {
        gameVersion: "5.0.16.97425",
      },
    );
    const beforeByDate = game(
      "legacy",
      "2026-06-01T15:00:00.000Z",
    );
    expect(patchEraForGame(beforeByBuild)).toBe("before");
    expect(metaSelectionForGame(beforeByBuild)?.era).toBe("before");
    expect(patchEraForGame(afterByVersion)).toBe("after");
    expect(patchEraForGame(beforeByDate)).toBe("before");
    expect(
      metaSelectionForGame(
        game("team", "2026-07-18T15:00:00.000Z", {
          playerCount: 4,
        }),
      ),
    ).toBeNull();
    expect(
      metaSelectionForGame(
        game("custom", "2026-07-18T15:00:00.000Z", {
          isLadderGame: false,
        }),
      ),
    ).toBeNull();
  });

  it("builds the canonical real meta endpoint", () => {
    expect(
      metaApiPath({
        axis: "mmr",
        band: 4500,
        matchup: "TvZ",
        era: "after",
      }),
    ).toBe(
      "/v1/meta/ladder?axis=mmr&band=4500&matchup=TvZ&era=after",
    );
  });

  it("prioritizes new, then rising, then highest-volume openers", () => {
    const row: MetaRow = {
      era: "after",
      bandType: "league",
      band: 4,
      bandLabel: "Diamond",
      matchup: "PvZ",
      n: 200,
      updatedAt: "2026-07-18T00:00:00.000Z",
      prevUpdatedAt: "2026-07-11T00:00:00.000Z",
      openers: [
        {
          build: "PvZ - Stable",
          games: 100,
          wins: 60,
          losses: 40,
          winRate: 0.6,
          frequency: 0.5,
          winRateDelta: 0,
          freqDelta: 0,
          isNew: false,
        },
        {
          build: "PvZ - Rising",
          games: 40,
          wins: 22,
          losses: 18,
          winRate: 0.55,
          frequency: 0.2,
          winRateDelta: 0.02,
          freqDelta: 0.04,
          isNew: false,
        },
        {
          build: "PvZ - New",
          games: 12,
          wins: 7,
          losses: 5,
          winRate: 7 / 12,
          frequency: 0.06,
          winRateDelta: null,
          freqDelta: null,
          isNew: true,
        },
      ],
    };
    expect(pickMetaMover(row)?.opener.build).toBe("PvZ - New");
    row.openers[2].isNew = false;
    expect(pickMetaMover(row)).toMatchObject({
      kind: "rising",
      opener: { build: "PvZ - Rising" },
    });
    row.openers[1].freqDelta = -0.04;
    expect(pickMetaMover(row)).toMatchObject({
      kind: "top",
      opener: { build: "PvZ - Stable" },
    });
  });

  it("never promotes an unclassified opener as new, rising, or top", () => {
    const row: MetaRow = {
      era: "after",
      bandType: "league",
      band: 4,
      bandLabel: "Diamond",
      matchup: "PvZ",
      n: 200,
      updatedAt: "2026-07-18T00:00:00.000Z",
      prevUpdatedAt: "2026-07-11T00:00:00.000Z",
      openers: [
        {
          build: "PvZ - Macro Transition (Unclassified)",
          games: 120,
          wins: 70,
          losses: 50,
          winRate: 7 / 12,
          frequency: 0.6,
          winRateDelta: 0.03,
          freqDelta: 0.08,
          isNew: true,
        },
        {
          build: "PvZ - Stargate",
          games: 40,
          wins: 22,
          losses: 18,
          winRate: 0.55,
          frequency: 0.2,
          winRateDelta: 0,
          freqDelta: 0,
          isNew: false,
        },
      ],
    };
    // The catch-all dominates on every axis, yet the real opener wins.
    expect(pickMetaMover(row)).toMatchObject({
      kind: "top",
      opener: { build: "PvZ - Stargate" },
    });
    row.openers[1] = { ...row.openers[1], build: "Unclassified - Protoss" };
    expect(pickMetaMover(row)).toBeNull();
  });
});
