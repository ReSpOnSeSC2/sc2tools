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
    expect(countDocuments).toHaveBeenNthCalledWith(1, {
      userId: "u1",
      isResumedFromReplay: { $ne: true },
    });
    expect(countDocuments).toHaveBeenNthCalledWith(2, {
      userId: "u1",
      isResumedFromReplay: { $ne: true },
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

describe("GamesService.replayArchiveMarkers", () => {
  test("returns safe marker identities from one projected batch query", async () => {
    const storedAt = new Date("2026-08-11T12:00:00.000Z");
    const toArray = jest.fn(async () => [
      {
        gameId: "archived",
        replayFile: {
          storedAt,
          sizeBytes: 98765,
          sha256: "A".repeat(64),
          uploadId: "must-not-leak",
        },
      },
      {
        gameId: "malformed",
        replayFile: { storedAt, sizeBytes: 10, sha256: "not-a-hash" },
      },
    ]);
    const find = jest.fn(() => ({ toArray }));
    const service = new GamesService({ games: { find } });

    const markers = await service.replayArchiveMarkers("u1", [
      "archived",
      "missing",
      "malformed",
      "archived",
    ]);

    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(
      { userId: "u1", gameId: { $in: ["archived", "missing", "malformed"] } },
      {
        projection: {
          _id: 0,
          gameId: 1,
          "replayFile.storedAt": 1,
          "replayFile.sizeBytes": 1,
          "replayFile.sha256": 1,
        },
      },
    );
    expect(markers.get("archived")).toEqual({
      available: true,
      sizeBytes: 98765,
      sha256: "a".repeat(64),
      storedAt,
    });
    expect(markers.get("missing")).toEqual({ available: false });
    expect(markers.get("malformed")).toEqual({ available: false });
    expect(markers.get("archived")).not.toHaveProperty("uploadId");
  });

  test("empty input avoids a database query", async () => {
    const find = jest.fn();
    const service = new GamesService({ games: { find } });

    await expect(service.replayArchiveMarkers("u1", [])).resolves.toEqual(
      new Map(),
    );
    expect(find).not.toHaveBeenCalled();
  });
});
