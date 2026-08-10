// @ts-nocheck
"use strict";

const {
  GameVodsService,
  TWITCH_ARCHIVES_QUERY,
  gameStartMs,
  normalizeTwitchLogin,
  normalizeYoutubeArchiveInput,
  extractYoutubeVideoIds,
  extractYoutubeChannelId,
  extractYoutubeVideoOwnerChannelId,
  parseYoutubeBroadcastDetails,
  parseTwitchArchives,
  findContainingVod,
  buildTimestampUrl,
} = require("../src/services/gameVods");

const jsonResponse = (body, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const htmlResponse = (html, ok = true, status = 200) => ({
  ok,
  status,
  text: async () => html,
  json: async () => ({}),
});

function twitchPayload({
  id = "1234567890",
  start = "2026-08-10T18:00:00.000Z",
  duration = 7200,
} = {}) {
  return {
    data: {
      user: {
        videos: {
          edges: [
            { node: { id, publishedAt: start, lengthSeconds: duration } },
          ],
        },
      },
    },
  };
}

function youtubeWatchPage({
  start = "2026-08-10T18:30:00.000Z",
  end = "2026-08-10T20:30:00.000Z",
  duration,
  channelId = "UC9OluGthYmZo0vsF9IjicFg",
} = {}) {
  return JSON.stringify({
    microformat: {
      playerMicroformatRenderer: {
        liveBroadcastDetails: {
          startTimestamp: start,
          ...(end ? { endTimestamp: end } : {}),
        },
      },
    },
    videoDetails: {
      channelId,
      ...(duration ? { lengthSeconds: String(duration) } : {}),
    },
  });
}

describe("services/gameVods pure helpers", () => {
  test("prefers exact startedAt and falls back to replay end minus duration", () => {
    expect(
      gameStartMs({
        startedAt: "2026-08-10T19:00:00.000Z",
        date: "2026-08-10T19:30:00.000Z",
        durationSec: 1200,
      }),
    ).toBe(Date.parse("2026-08-10T19:00:00.000Z"));
    expect(
      gameStartMs({
        date: "2026-08-10T19:30:00.000Z",
        durationSec: 1200,
      }),
    ).toBe(Date.parse("2026-08-10T19:10:00.000Z"));
    expect(gameStartMs({ date: "bad", durationSec: 1200 })).toBeNull();
  });

  test("normalizes only safe Twitch channel inputs", () => {
    expect(normalizeTwitchLogin("https://www.twitch.tv/Some_Caster"))
      .toBe("some_caster");
    expect(normalizeTwitchLogin("twitch.tv/Some_Caster")).toBe("some_caster");
    expect(normalizeTwitchLogin("https://evil.test/Some_Caster")).toBeNull();
    expect(normalizeTwitchLogin("https://twitch.tv/videos/123")).toBeNull();
  });

  test("derives /streams without duplicating an existing /live suffix", () => {
    expect(
      normalizeYoutubeArchiveInput(
        "https://www.youtube.com/@SomeCaster/live",
      ),
    ).toMatchObject({
      videoId: null,
      streamsUrls: ["https://www.youtube.com/@SomeCaster/streams"],
    });
    expect(
      normalizeYoutubeArchiveInput(
        "https://www.youtube.com/@SomeCaster/videos",
      ),
    ).toMatchObject({
      streamsUrls: ["https://www.youtube.com/@SomeCaster/streams"],
    });
    expect(() => normalizeYoutubeArchiveInput("https://evil.test/@caster"))
      .toThrow();
  });

  test("extracts recent YouTube ids in order, deduplicated and capped", () => {
    const html = [
      '"videoRenderer":{"videoId":"AbCdEf12345"}',
      '"videoRenderer":{"videoId":"AbCdEf12345"}',
      '"gridVideoRenderer":{"title":{},"videoId":"ZyXwVu98765"}',
      // Further ids are ignored after the requested cap.
      '"videoId":"Qwerty12345"',
    ].join("");
    expect(extractYoutubeVideoIds(html, 2)).toEqual([
      "AbCdEf12345",
      "ZyXwVu98765",
    ]);
  });

  test("extracts channel ownership from channel and main watch payloads", () => {
    const channelId = "UC9OluGthYmZo0vsF9IjicFg";
    expect(extractYoutubeChannelId(`{"externalId":"${channelId}"}`))
      .toBe(channelId);
    expect(extractYoutubeVideoOwnerChannelId(youtubeWatchPage({ channelId })))
      .toBe(channelId);
  });

  test("accepts true broadcast timing, with duration fallback, never uploadDate", () => {
    const explicit = parseYoutubeBroadcastDetails(youtubeWatchPage());
    expect(explicit).toEqual({
      startMs: Date.parse("2026-08-10T18:30:00.000Z"),
      endMs: Date.parse("2026-08-10T20:30:00.000Z"),
    });

    const fallback = parseYoutubeBroadcastDetails(
      youtubeWatchPage({ end: null, duration: 3600 }),
    );
    expect(fallback).toEqual({
      startMs: Date.parse("2026-08-10T18:30:00.000Z"),
      endMs: Date.parse("2026-08-10T19:30:00.000Z"),
    });
    expect(
      parseYoutubeBroadcastDetails(
        JSON.stringify({ uploadDate: "2026-08-10", lengthSeconds: "3600" }),
      ),
    ).toBeNull();
  });

  test("parses bounded Twitch archives and builds provider-owned safe URLs", () => {
    const vods = parseTwitchArchives(twitchPayload());
    expect(vods).toHaveLength(1);
    expect(
      findContainingVod(vods, Date.parse("2026-08-10T19:00:00.000Z")),
    ).toMatchObject({ videoId: "1234567890" });
    expect(buildTimestampUrl("twitch", "1234567890", 3661)).toBe(
      "https://www.twitch.tv/videos/1234567890?t=1h1m1s",
    );
    expect(buildTimestampUrl("youtube", "AbCdEf12345", 61)).toBe(
      "https://www.youtube.com/watch?v=AbCdEf12345&t=61s",
    );
    expect(buildTimestampUrl("youtube", "../not-safe", 1)).toBeNull();
  });
});

describe("GameVodsService", () => {
  test("matches both saved channels even when chat is disabled", async () => {
    const calls = [];
    const users = {
      getPreferences: jest.fn(async () => ({
        twitch: { enabled: false, channel: "https://twitch.tv/TestCaster" },
        youtube: {
          enabled: false,
          channel: "https://youtube.com/@TestCaster/live",
        },
      })),
    };
    const service = new GameVodsService({
      users,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("gql.twitch.tv")) {
          return jsonResponse(twitchPayload());
        }
        if (String(url).endsWith("/@TestCaster/streams")) {
          return htmlResponse(
            '{"externalId":"UC9OluGthYmZo0vsF9IjicFg",' +
              '"videoRenderer":{"videoId":"AbCdEf12345"}}',
          );
        }
        if (String(url).includes("watch?v=AbCdEf12345")) {
          return htmlResponse(youtubeWatchPage());
        }
        throw new Error(`unexpected URL ${url}`);
      },
    });

    const result = await service.resolveForGames("user-1", [
      {
        gameId: "g1",
        startedAt: "2026-08-10T19:00:00.000Z",
        date: "2026-08-10T19:20:00.000Z",
        durationSec: 1200,
      },
    ]);

    expect(users.getPreferences).toHaveBeenCalledWith("user-1", "multichat");
    expect(result.configuredPlatforms).toEqual(["twitch", "youtube"]);
    expect(result.linksByGameId.g1).toEqual([
      {
        platform: "twitch",
        perspective: "me",
        playerName: "You",
        videoId: "1234567890",
        url: "https://www.twitch.tv/videos/1234567890?t=1h0m0s",
        offsetSec: 3600,
      },
      {
        platform: "youtube",
        perspective: "me",
        playerName: "You",
        videoId: "AbCdEf12345",
        url: "https://www.youtube.com/watch?v=AbCdEf12345&t=1800s",
        offsetSec: 1800,
      },
    ]);
    const gqlBody = JSON.parse(
      calls.find((call) => call.url.includes("gql.twitch.tv")).init.body,
    );
    expect(gqlBody.query).toBe(TWITCH_ARCHIVES_QUERY);
    expect(gqlBody.query).toContain("first:30");
    expect(gqlBody.query).not.toContain("viewable");
    expect(gqlBody.variables).toEqual({ login: "testcaster" });
  });

  test("uses public Pulse pro links for opponent POV, gated and deduplicated", async () => {
    const pulseIntel = {
      getIntel: jest.fn(async () => ({
        pro: {
          nickname: "PublicPro",
          links: { TWITCH: "https://www.twitch.tv/PublicPro" },
        },
      })),
    };
    let twitchFetches = 0;
    const service = new GameVodsService({
      users: {
        getPreferences: async () => ({
          twitch: { enabled: false, channel: "MyCaster" },
        }),
      },
      pulseIntel,
      fetchImpl: async (_url, init) => {
        twitchFetches += 1;
        const login = JSON.parse(init.body).variables.login;
        return jsonResponse(twitchPayload({
          id: login === "publicpro" ? "777" : "555",
        }));
      },
    });
    const games = [
      {
        gameId: "g1",
        startedAt: "2026-08-10T19:00:00Z",
        opponent: { pulseCharacterId: "42", displayName: "Reynor" },
      },
      {
        gameId: "g2",
        startedAt: "2026-08-10T19:05:00Z",
        opponent: { pulseCharacterId: "42", displayName: "Reynor" },
      },
    ];

    const gated = await service.resolveForGames("user-1", games);
    expect(gated.configuredPlatforms).toEqual(["twitch"]);
    expect(gated.linksByGameId.g1).toEqual([
      expect.objectContaining({ perspective: "me", videoId: "555" }),
    ]);
    expect(pulseIntel.getIntel).not.toHaveBeenCalled();

    const result = await service.resolveForGames("user-1", games, {
      includeOpponent: true,
    });
    expect(pulseIntel.getIntel).toHaveBeenCalledTimes(1);
    expect(pulseIntel.getIntel).toHaveBeenCalledWith("42");
    // Own channel was reused from cache; the one additional fetch is the
    // deduplicated public opponent channel shared by both games.
    expect(twitchFetches).toBe(2);
    expect(result.configuredPlatforms).toEqual(["twitch"]);
    expect(result.linksByGameId.g1).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ perspective: "me", videoId: "555" }),
        expect.objectContaining({
          platform: "twitch",
          perspective: "opponent",
          playerName: "Reynor",
          videoId: "777",
          offsetSec: 3600,
        }),
      ]),
    );
    expect(result.linksByGameId.g2).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ perspective: "me", videoId: "555" }),
        expect.objectContaining({
          perspective: "opponent",
          playerName: "Reynor",
          offsetSec: 3900,
        }),
      ]),
    );
  });

  test("rejects YouTube candidates owned by a different channel", async () => {
    const owner = "UC9OluGthYmZo0vsF9IjicFg";
    const other = "UCYxRlFDqcWM4y7FfpiAN3KQ";
    const service = new GameVodsService({
      users: {
        getPreferences: async () => ({
          youtube: { channel: "https://youtube.com/@TestCaster" },
        }),
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/@TestCaster/streams")) {
          return htmlResponse(
            `{"externalId":"${owner}","videoId":"AbCdEf12345"}`,
          );
        }
        return htmlResponse(youtubeWatchPage({ channelId: other }));
      },
    });

    const result = await service.resolveForGames("user-1", [
      { gameId: "g1", startedAt: "2026-08-10T19:00:00Z" },
    ]);

    expect(result.linksByGameId.g1).toEqual([]);
  });

  test("rejects unverified YouTube channel-page candidates", async () => {
    let watchFetches = 0;
    const service = new GameVodsService({
      users: {
        getPreferences: async () => ({
          youtube: { channel: "https://youtube.com/@TestCaster" },
        }),
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/@TestCaster/streams")) {
          return htmlResponse('{"videoId":"AbCdEf12345"}');
        }
        watchFetches += 1;
        return htmlResponse(youtubeWatchPage());
      },
    });

    const result = await service.resolveForGames("user-1", [
      { gameId: "g1", startedAt: "2026-08-10T19:00:00Z" },
    ]);

    expect(result.linksByGameId.g1).toEqual([]);
    expect(watchFetches).toBe(0);
  });

  test("provider failures are logged, fail soft, and negative-cache in flight", async () => {
    let fetches = 0;
    const log = { warn: jest.fn() };
    const service = new GameVodsService({
      users: {
        getPreferences: async () => ({
          twitch: { channel: "somecaster", enabled: false },
        }),
      },
      log,
      fetchImpl: async () => {
        fetches += 1;
        throw new Error("upstream down");
      },
    });
    const games = [
      { gameId: "g1", startedAt: "2026-08-10T19:00:00Z" },
    ];

    const [first, second] = await Promise.all([
      service.resolveForGames("user-1", games),
      service.resolveForGames("user-1", games),
    ]);
    expect(fetches).toBe(1);
    expect(first).toEqual({
      configuredPlatforms: ["twitch"],
      linksByGameId: { g1: [] },
    });
    expect(second).toEqual(first);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "twitch" }),
      "game_vod_lookup_failed",
    );

    await service.resolveForGames("user-1", games);
    expect(fetches).toBe(1);
  });
});
