// @ts-nocheck
"use strict";

const {
  PulseMatchVodsService,
  parseTwitchVod,
} = require("../src/services/pulseMatchVods");

const END = "2026-08-10T19:11:20.000Z";

function participant({ id, tag, vod = null }) {
  return {
    team: {
      members: [
        {
          character: {
            battlenetId: id,
            tag,
            name: `${tag}#123`,
          },
        },
      ],
    },
    twitchVodUrl: vod,
  };
}

function pulseRow(overrides = {}) {
  return {
    match: {
      date: overrides.date || END,
      duration: overrides.duration ?? 776,
      id: overrides.id || 627549886,
    },
    map: { name: overrides.map || "Sanctuary III LE" },
    participants:
      overrides.participants ||
      [
        participant({
          id: 3767746,
          tag: "Streamer",
          vod: "https://www.twitch.tv/videos/111111?t=4h23m23s",
        }),
        participant({
          id: 519356,
          tag: "Angelus",
          vod: "https://www.twitch.tv/videos/2842398130?t=15803s",
        }),
      ],
  };
}

function game(overrides = {}) {
  return {
    gameId: overrides.gameId || "game-1",
    date: overrides.date || END,
    map: overrides.map || "Sanctuary III LE",
    durationSec: overrides.durationSec ?? 776,
    myToonHandle: overrides.myToonHandle ?? "2-S2-1-3767746",
    opponent: {
      toonHandle: overrides.opponentToonHandle || "2-S2-1-519356",
      displayName: "Angelus",
    },
  };
}

function response(result) {
  return { ok: true, status: 200, json: async () => ({ result }) };
}

describe("PulseMatchVodsService", () => {
  test("keeps both participant VODs attached to their correct perspectives", async () => {
    const calls = [];
    const service = new PulseMatchVodsService({
      fetchImpl: async (url) => {
        calls.push(url);
        return response([pulseRow()]);
      },
    });

    const result = await service.resolveForGames([game()]);

    expect(calls).toHaveLength(1);
    const request = new URL(calls[0]);
    expect(request.pathname).toBe("/sc2/api/character-matches");
    expect(request.searchParams.get("toonHandle")).toBe("2-S2-1-519356");
    expect(request.searchParams.get("type")).toBe("_1V1");
    expect(request.searchParams.get("limit")).toBe("100");
    expect(result.linksByGameId["game-1"]).toEqual([
      {
        platform: "twitch",
        perspective: "me",
        playerName: "Streamer",
        url: "https://www.twitch.tv/videos/111111?t=4h23m23s",
        offsetSec: 15803,
        videoId: "111111",
        source: "sc2pulse",
      },
      {
        platform: "twitch",
        perspective: "opponent",
        playerName: "Angelus",
        url: "https://www.twitch.tv/videos/2842398130?t=15803s",
        offsetSec: 15803,
        videoId: "2842398130",
        source: "sc2pulse",
      },
    ]);
  });

  test("matches by end time, normalized map, duration, and participant ids", async () => {
    const rows = [
      pulseRow({ id: 1, date: "2026-08-10T19:20:00Z" }),
      pulseRow({ id: 2, map: "Wrong Map LE" }),
      pulseRow({ id: 3, duration: 1200 }),
      pulseRow({
        id: 4,
        participants: [
          participant({ id: 999, tag: "Someone" }),
          participant({ id: 888, tag: "Else" }),
        ],
      }),
      pulseRow({
        id: 5,
        date: "2026-08-10T19:11:50Z",
        duration: 790,
        participants: [
          participant({
            id: 3767746,
            tag: "Streamer",
            vod: "https://twitch.tv/videos/555?t=100s",
          }),
          participant({ id: 519356, tag: "Angelus" }),
        ],
      }),
    ];
    const service = new PulseMatchVodsService({
      fetchImpl: async () => response(rows),
    });

    const result = await service.resolveForGames([game()]);
    expect(result.linksByGameId["game-1"]).toMatchObject([
      { perspective: "me", videoId: "555", offsetSec: 100 },
    ]);
  });

  test("uses the queried toon as opponent and the other 1v1 participant as me", async () => {
    const service = new PulseMatchVodsService({
      fetchImpl: async () => response([pulseRow()]),
    });

    const result = await service.resolveForGames([
      game({ myToonHandle: null }),
    ]);
    expect(result.linksByGameId["game-1"].map((link) => link.perspective)).toEqual([
      "me",
      "opponent",
    ]);
  });

  test("queries each distinct opponent once and reuses fresh cached pages", async () => {
    const calls = [];
    const service = new PulseMatchVodsService({
      fetchImpl: async (url) => {
        calls.push(url);
        const toon = new URL(url).searchParams.get("toonHandle");
        if (toon === "2-S2-1-519356") return response([pulseRow()]);
        return response([
          pulseRow({
            participants: [
              participant({ id: 3767746, tag: "Streamer" }),
              participant({
                id: 777777,
                tag: "OtherOpponent",
                vod: "https://twitch.tv/videos/777?t=30s",
              }),
            ],
          }),
        ]);
      },
    });
    const games = [
      game({ gameId: "a" }),
      game({ gameId: "b" }),
      game({ gameId: "c", opponentToonHandle: "2-S2-1-777777" }),
    ];

    await service.resolveForGames(games);
    await service.resolveForGames(games);
    expect(calls).toHaveLength(2);
  });

  test("deduplicates concurrent fetches for the same toon handle", async () => {
    let release;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const service = new PulseMatchVodsService({
      fetchImpl: async () => {
        calls += 1;
        await waiting;
        return response([pulseRow()]);
      },
    });

    const first = service.resolveForGames([game()]);
    const second = service.resolveForGames([game()]);
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  test("fails soft and serves stale cached matches on refresh errors", async () => {
    let now = 0;
    let fail = false;
    const logger = { warn: jest.fn() };
    const service = new PulseMatchVodsService({
      now: () => now,
      cacheTtlMs: 100,
      logger,
      fetchImpl: async () => {
        if (fail) throw new Error("upstream unavailable");
        return response([pulseRow()]);
      },
    });
    const first = await service.resolveForGames([game()]);
    now = 1000;
    fail = true;
    const second = await service.resolveForGames([game()]);

    expect(second).toEqual(first);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ toonHandle: "2-S2-1-519356" }),
      "pulse_match_vods_fetch_failed",
    );
  });

  test("does not query or fabricate links for unusable local identities", async () => {
    const fetchImpl = jest.fn();
    const service = new PulseMatchVodsService({ fetchImpl });
    const result = await service.resolveForGames([
      game({ gameId: "bad", opponentToonHandle: "not-a-toon" }),
      { gameId: "missing-opponent", date: END, map: "Sanctuary III LE" },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ linksByGameId: {} });
  });
});

describe("parseTwitchVod", () => {
  test("accepts only timestamped HTTPS twitch video links", () => {
    expect(parseTwitchVod("https://twitch.tv/videos/123?t=1h2m3s")).toEqual({
      url: "https://twitch.tv/videos/123?t=1h2m3s",
      videoId: "123",
      offsetSec: 3723,
    });
    expect(parseTwitchVod("https://www.twitch.tv/videos/123?t=0s")).toMatchObject({
      videoId: "123",
      offsetSec: 0,
    });
    expect(parseTwitchVod("http://twitch.tv/videos/123?t=20s")).toBeNull();
    expect(parseTwitchVod("https://evil.example/videos/123?t=20s")).toBeNull();
    expect(parseTwitchVod("https://not-twitch.tv/videos/123?t=20s")).toBeNull();
    expect(parseTwitchVod("https://twitch.tv/videos/123")).toBeNull();
    expect(parseTwitchVod("https://twitch.tv/some-channel?t=20s")).toBeNull();
    expect(parseTwitchVod("https://twitch.tv/videos/not-a-number?t=20s")).toBeNull();
  });
});
