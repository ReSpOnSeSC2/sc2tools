// @ts-nocheck
"use strict";

const { GameVodLinksService } = require("../src/services/gameVodLinks");

const GAMES = [{ gameId: "g1" }, { gameId: "g2" }];

function twitch(perspective, id, name = "Player") {
  return {
    platform: "twitch",
    perspective,
    playerName: name,
    url: `https://www.twitch.tv/videos/${id}?t=1h2m3s`,
    offsetSec: 3723,
    videoId: id,
  };
}

describe("GameVodLinksService", () => {
  test("merges both sources while keeping one icon per platform and POV", async () => {
    const archives = {
      resolveForGames: jest.fn(async () => ({
        configuredPlatforms: ["youtube", "twitch"],
        linksByGameId: { g1: [twitch("me", "11", "You")] },
      })),
    };
    const pulseMatches = {
      resolveForGames: jest.fn(async () => ({
        linksByGameId: {
          g1: [
            twitch("me", "11", "MyTag"),
            twitch("opponent", "22", "Opponent"),
          ],
        },
      })),
    };
    const service = new GameVodLinksService({ archives, pulseMatches });

    const result = await service.resolveForGames("u1", GAMES, {
      includeOpponent: true,
    });

    expect(archives.resolveForGames).toHaveBeenCalledWith("u1", GAMES, {
      includeOpponent: true,
    });
    expect(pulseMatches.resolveForGames).toHaveBeenCalledWith(GAMES);
    expect(result.configuredPlatforms).toEqual(["twitch", "youtube"]);
    expect(result.linksByGameId.g1).toEqual([
      twitch("me", "11", "You"),
      twitch("opponent", "22", "Opponent"),
    ]);
    expect(result.linksByGameId.g2).toEqual([]);
  });

  test("does not query SC2Pulse when opponent enrichment was not requested", async () => {
    const archives = {
      resolveForGames: jest.fn(async () => ({ linksByGameId: {} })),
    };
    const pulseMatches = { resolveForGames: jest.fn() };
    const service = new GameVodLinksService({ archives, pulseMatches });

    await service.resolveForGames("u1", GAMES, { includeOpponent: false });

    expect(pulseMatches.resolveForGames).not.toHaveBeenCalled();
  });

  test("one upstream failure cannot hide the other source's links", async () => {
    const logger = { warn: jest.fn() };
    const archives = {
      resolveForGames: jest.fn(async () => {
        throw new Error("youtube changed");
      }),
    };
    const pulseMatches = {
      resolveForGames: jest.fn(async () => ({
        linksByGameId: { g1: [twitch("opponent", "22", "Opponent")] },
      })),
    };
    const service = new GameVodLinksService({
      archives,
      pulseMatches,
      log: logger,
    });

    const result = await service.resolveForGames("u1", GAMES, {
      includeOpponent: true,
    });

    expect(result.linksByGameId.g1).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ source: "archives" }),
      "game_vod_source_failed",
    );
  });

  test("drops malformed or cross-platform URLs at the merge boundary", async () => {
    const archives = {
      resolveForGames: jest.fn(async () => ({
        linksByGameId: {
          g1: [
            { ...twitch("me", "11"), url: "https://evil.example/videos/11" },
            {
              platform: "youtube",
              perspective: "opponent",
              playerName: "Opponent",
              url: "https://www.youtube.com/watch?v=abcdefghijk&t=5s",
              offsetSec: 5,
            },
          ],
        },
      })),
    };
    const service = new GameVodLinksService({ archives });

    const result = await service.resolveForGames("u1", [GAMES[0]]);

    expect(result.linksByGameId.g1).toEqual([
      expect.objectContaining({ platform: "youtube", perspective: "opponent" }),
    ]);
  });

  test("treats reserved JavaScript property names as ordinary game ids", async () => {
    const source = Object.create(null);
    source.constructor = [twitch("me", "11", "You")];
    source.__proto__ = [twitch("opponent", "22", "Opponent")];
    const service = new GameVodLinksService({
      archives: {
        resolveForGames: jest.fn(async () => ({ linksByGameId: source })),
      },
    });

    const result = await service.resolveForGames("u1", [
      { gameId: "constructor" },
      { gameId: "__proto__" },
    ]);

    expect(result.linksByGameId.constructor).toHaveLength(1);
    expect(result.linksByGameId.__proto__).toHaveLength(1);
    expect(Object.getPrototypeOf(result.linksByGameId)).toBeNull();
  });
});
