// @ts-nocheck
"use strict";

const { GamesService } = require("../src/services/games");

describe("GamesService.replayArchiveStatus", () => {
  test("counts completed replay markers without returning game identifiers", async () => {
    const countDocuments = jest
      .fn()
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(5);
    const service = new GamesService({ games: { countDocuments } });

    await expect(service.replayArchiveStatus("u1")).resolves.toEqual({
      totalGames: 12,
      archivedGames: 5,
      missingGames: 7,
      archiveComplete: false,
    });
    expect(countDocuments).toHaveBeenNthCalledWith(1, { userId: "u1" });
    expect(countDocuments).toHaveBeenNthCalledWith(2, {
      userId: "u1",
      "replayFile.storedAt": { $exists: true },
    });
  });

  test("reports a complete archive when every game has a marker", async () => {
    const countDocuments = jest
      .fn()
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(3);
    const service = new GamesService({ games: { countDocuments } });

    await expect(service.replayArchiveStatus("u2")).resolves.toEqual({
      totalGames: 3,
      archivedGames: 3,
      missingGames: 0,
      archiveComplete: true,
    });
  });

  test("zero games never requires a backfill", async () => {
    const countDocuments = jest.fn().mockResolvedValue(0);
    const service = new GamesService({ games: { countDocuments } });

    await expect(service.replayArchiveStatus("new-user")).resolves.toEqual({
      totalGames: 0,
      archivedGames: 0,
      missingGames: 0,
      archiveComplete: true,
    });
  });
});
