// @ts-nocheck
"use strict";

const { GamesService } = require("../src/services/games");

describe("GamesService.findMany", () => {
  test("uses one user-scoped query and restores the requested order", async () => {
    const toArray = jest.fn(async () => [
      { gameId: "a", userId: "u1" },
      { gameId: "b", userId: "u1" },
    ]);
    const find = jest.fn(() => ({ toArray }));
    const service = new GamesService({ games: { find } });

    const result = await service.findMany("u1", ["b", "a", "missing"]);

    expect(find).toHaveBeenCalledWith(
      {
        userId: "u1",
        gameId: { $in: ["b", "a", "missing"] },
        isResumedFromReplay: { $ne: true },
      },
      {
        projection: {
          _id: 0,
          replayUpload: 0,
          _customBuildSlug: 0,
          _customBuildRevision: 0,
          _customBuildReclassify: 0,
          _customBuildClassificationSequence: 0,
          _opponentBuildOrderWriteLease: 0,
        },
      },
    );
    expect(result.map((row) => row.gameId)).toEqual(["b", "a"]);
  });

  test("normalises duplicates and returns early for an empty input", async () => {
    const toArray = jest.fn(async () => [{ gameId: "g1" }]);
    const find = jest.fn(() => ({ toArray }));
    const service = new GamesService({ games: { find } });

    expect(await service.findMany("u1", [])).toEqual([]);
    expect(find).not.toHaveBeenCalled();

    const result = await service.findMany("u1", [" g1 ", "g1", ""]);
    expect(result.map((row) => row.gameId)).toEqual(["g1"]);
    expect(find).toHaveBeenCalledWith(
      {
        userId: "u1",
        gameId: { $in: ["g1"] },
        isResumedFromReplay: { $ne: true },
      },
      {
        projection: {
          _id: 0,
          replayUpload: 0,
          _customBuildSlug: 0,
          _customBuildRevision: 0,
          _customBuildReclassify: 0,
          _customBuildClassificationSequence: 0,
          _opponentBuildOrderWriteLease: 0,
        },
      },
    );
  });
});
