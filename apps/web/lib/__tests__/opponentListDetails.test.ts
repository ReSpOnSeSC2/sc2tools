import { describe, expect, it } from "vitest";
import { groupOpponentsByPlayer } from "../opponentGroups";
import { mergeOpponentListDetails, type OpponentLatestGame } from "../opponentListDetails";
import { isOpponentColumnOverrides, opponentColumns, opponentDetailSortValue, opponentListDetailsSelected } from "../opponentPresentation";
import type { Opp } from "@/components/analyzer/opponents/types";

const game = (gameId: string, date: string): OpponentLatestGame => ({ gameId, date, map: "Synthetic arena", result: "Victory", durationSec: 600,
  myBuild: "Gateway pressure", oppStrategy: "Hatch first", macroScore: 0, top3Leaks: [], replayAvailable: true, replaySizeBytes: 2000 });
const aDate = "2026-10-20T12:00:00Z", bDate = "2026-10-23T12:00:00Z";

describe("opponent list details", () => {
  it("merges linked identities using weighted samples and independently dated records", () => {
    const base: Opp = { pulseId: "alpha", pulseCharacterId: "1", wins: 1, losses: 0, games: 1, winRate: 1, lastPlayed: aDate,
      latestGame: game("alpha-game", aDate), duration: { sumSec: 600, samples: 1, averageSec: 600 },
      macro: { sum: 100, samples: 1, average: 100 }, latestOppBuildOrder: { gameId: "alpha-game", date: aDate }, opponentBuildOrderAvailability: "known" };
    const other: Opp = { ...base, pulseId: "beta", pulseCharacterId: "2", games: 9, lastPlayed: bDate,
      latestGame: game("beta-game", bDate), duration: { sumSec: 900, samples: 9, averageSec: 100 },
      macro: { sum: 90, samples: 9, average: 10 }, latestOppBuildOrder: null, opponentBuildOrderAvailability: "unknown" };
    const [merged] = groupOpponentsByPlayer([base, other], { 1: { accountId: "same", proId: null, proNickname: null }, 2: { accountId: "same", proId: null, proNickname: null } });
    expect(merged.duration).toEqual({ sumSec: 1500, samples: 10, averageSec: 150 });
    expect(merged.macro).toEqual({ sum: 190, samples: 10, average: 19 });
    expect(merged.latestGame?.gameId).toBe("beta-game");
    expect(merged.latestOppBuildOrder?.gameId).toBe("alpha-game");
    expect(merged.opponentBuildOrderAvailability).toBe("unknown");
  });
  it("keeps missing samples unknown and measured zero distinct", () => {
    expect(mergeOpponentListDetails([{ duration: { sumSec: 0, samples: 0, averageSec: null }, macro: { sum: 0, samples: 0, average: null } }])).toMatchObject({ duration: { averageSec: null }, macro: { average: null } });
    expect(mergeOpponentListDetails([{ duration: { sumSec: 0, samples: 1, averageSec: 0 }, macro: { sum: 0, samples: 1, average: 0 } }])).toMatchObject({ duration: { averageSec: 0 }, macro: { average: 0 } });
    expect(mergeOpponentListDetails([{ macro: { sum: 110, samples: 1, average: 110 } }])).toMatchObject({ macro: { samples: 0, average: null } });
  });
  it("uses the same stable game-id tie break as the API and ignores invalid dates", () => {
    const selected = mergeOpponentListDetails([{ latestGame: game("z-game", aDate) }, { latestGame: game("a-game", aDate) }, { latestGame: game("bad", "invalid") }]);
    expect(selected.latestGame?.gameId).toBe("a-game");
    expect(mergeOpponentListDetails([{}])).toEqual({});
  });
  it("retains old and future boolean choices without admitting unknown columns", () => {
    const saved = { pulseId: true, mmr: false, avgGameLength: true, futureColumn: true };
    expect(isOpponentColumnOverrides(saved)).toBe(true);
    const selected = opponentColumns(saved, true);
    expect(selected).toMatchObject({ pulseId: true, mmr: false, avgGameLength: true, latestReplay: false });
    expect(selected).not.toHaveProperty("futureColumn");
    expect(isOpponentColumnOverrides({ mmr: "yes" })).toBe(false);
  });
  it("requests summaries only for selected data columns and keeps zero sortable", () => {
    expect(opponentListDetailsSelected(opponentColumns({ region: true, notes: true }, false))).toBe(false);
    expect(opponentListDetailsSelected(opponentColumns({ macroBreakdown: true }, false))).toBe(true);
    const row = { pulseId: "a", wins: 0, losses: 0, games: 0, winRate: 0, lastPlayed: aDate, latestGame: game("a", aDate) };
    expect(opponentDetailSortValue(row, "macroBreakdown")).toBe(0);
    expect(opponentDetailSortValue(row, "buildOrderDate")).toBeNull();
    expect(opponentDetailSortValue(row, "map")).toBe("Synthetic arena");
  });
});
