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
  matchConfiguredYoutubeIdentity,
  parseTwitchArchives,
  findContainingVod,
  buildTimestampUrl,
} = require("../src/services/gameVods");
const {
  listYoutubeGameVods,
  YOUTUBE_ONGOING_GRACE_MS,
} = require("../src/services/platformOauthClients");

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

  test("binds OAuth archives only to exact channel ids and modern handles", () => {
    const official = {
      channelId: "UC9OluGthYmZo0vsF9IjicFg",
      customUrl: "@TestCaster",
    };
    expect(matchConfiguredYoutubeIdentity("@testcaster", official).matches)
      .toBe(true);
    expect(matchConfiguredYoutubeIdentity("TestCaster", official).matches)
      .toBe(true);
    expect(matchConfiguredYoutubeIdentity("AbCdEf12345", official))
      .toMatchObject({
        matches: false,
        reason: "oauth_identity_unverifiable",
      });
    expect(matchConfiguredYoutubeIdentity(
      "https://youtube.com/channel/UC9OluGthYmZo0vsF9IjicFg",
      official,
    ).matches).toBe(true);
    expect(matchConfiguredYoutubeIdentity("@SomeoneElse", official))
      .toMatchObject({ matches: false, reason: "oauth_handle_mismatch" });
    expect(matchConfiguredYoutubeIdentity("@TestCaster", {
      ...official,
      handleLookupAttempted: true,
      handleChannelId: "UCYxRlFDqcWM4y7FfpiAN3KQ",
    })).toMatchObject({ matches: false, reason: "oauth_handle_mismatch" });
    expect(matchConfiguredYoutubeIdentity(
      "https://youtube.com/c/TestCaster",
      official,
    )).toMatchObject({
      matches: false,
      reason: "oauth_identity_unverifiable",
    });
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

  test("prefers horizontal per game while preserving portrait prefix and tail", () => {
    const portrait = {
      platform: "youtube",
      videoId: "Portt123456",
      startMs: Date.parse("2026-08-10T18:00:00.000Z"),
      endMs: Date.parse("2026-08-10T22:00:00.000Z"),
      orientation: "portrait",
    };
    const horizontal = {
      platform: "youtube",
      videoId: "Horiz123456",
      startMs: Date.parse("2026-08-10T18:00:10.000Z"),
      endMs: Date.parse("2026-08-10T21:00:00.000Z"),
      orientation: "horizontal",
    };
    expect(findContainingVod(
      [portrait, horizontal],
      Date.parse("2026-08-10T18:00:05.000Z"),
    )).toMatchObject({ videoId: portrait.videoId });
    expect(findContainingVod(
      [portrait, horizontal],
      Date.parse("2026-08-10T19:00:00.000Z"),
    )).toMatchObject({ videoId: horizontal.videoId });
    expect(findContainingVod(
      [portrait, horizontal],
      Date.parse("2026-08-10T21:30:00.000Z"),
    )).toMatchObject({ videoId: portrait.videoId });
    expect(findContainingVod([{
      ...portrait,
      videoId: "Unkwn123456",
      orientation: "unknown",
    }], Date.parse("2026-08-10T19:00:00.000Z")))
      .toMatchObject({ videoId: "Unkwn123456" });
  });
});

describe("official YouTube game VOD client", () => {
  test("short-circuits a mismatched canonical channel before scanning uploads", async () => {
    const calls = [];
    const fetchImpl = jest.fn(async (rawUrl) => {
      const url = new URL(String(rawUrl));
      calls.push(url);
      return jsonResponse({
        items: [{
          id: "UC9OluGthYmZo0vsF9IjicFg",
          contentDetails: { relatedPlaylists: { uploads: "UUuploads" } },
        }],
      });
    });

    const result = await listYoutubeGameVods("access-secret", fetchImpl, {
      expectedChannelId: "UCYxRlFDqcWM4y7FfpiAN3KQ",
    });

    expect(result).toMatchObject({
      channelId: "UC9OluGthYmZo0vsF9IjicFg",
      vods: [],
      uploadsScanned: 0,
      pagesFetched: 0,
      videoBatches: 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].pathname).toMatch(/\/channels$/);
  });

  test("pages uploads, requests bounded details, and records stream orientation", async () => {
    const horizontalId = "Horiz123456";
    const portraitId = "Portt123456";
    const ongoingId = "Livee123456";
    const uploadId = "Uplod123456";
    const historicalId = "Hstry123456";
    const portraitOnlyId = "SoloP123456";
    const ongoingNow = Date.parse("2026-08-10T21:10:00.000Z");
    const calls = [];
    const fetchImpl = jest.fn(async (rawUrl, init) => {
      const url = new URL(String(rawUrl));
      calls.push({ url, init });
      if (url.pathname.endsWith("/channels")) {
        if (url.searchParams.get("forHandle")) {
          return jsonResponse({
            items: [{ id: "UC9OluGthYmZo0vsF9IjicFg" }],
          });
        }
        return jsonResponse({
          items: [{
            id: "UC9OluGthYmZo0vsF9IjicFg",
            snippet: { customUrl: "@TestCaster" },
            contentDetails: { relatedPlaylists: { uploads: "UUuploads" } },
          }],
        });
      }
      if (url.pathname.endsWith("/playlistItems")) {
        if (!url.searchParams.get("pageToken")) {
          return jsonResponse({
            nextPageToken: "page-two",
            items: [horizontalId, portraitId].map((videoId) => ({
              contentDetails: { videoId },
            })),
          });
        }
        return jsonResponse({
          items: [
            ongoingId,
            uploadId,
            historicalId,
            portraitOnlyId,
          ].map((videoId) => ({ contentDetails: { videoId } })),
        });
      }
      if (url.pathname.endsWith("/videos")) {
        return jsonResponse({
          items: [
            {
              id: horizontalId,
              liveStreamingDetails: {
                actualStartTime: "2026-08-10T18:30:00.000Z",
                actualEndTime: "2026-08-10T20:30:00.000Z",
              },
              player: { embedWidth: "1920", embedHeight: "1080" },
            },
            {
              id: portraitId,
              liveStreamingDetails: {
                actualStartTime: "2026-08-10T18:30:08.000Z",
                actualEndTime: "2026-08-10T20:30:00.000Z",
              },
              player: { embedWidth: "608", embedHeight: "1080" },
            },
            {
              id: ongoingId,
              liveStreamingDetails: {
                actualStartTime: "2026-08-10T21:00:00.000Z",
              },
              snippet: { liveBroadcastContent: "live" },
              player: { embedWidth: "1920", embedHeight: "1080" },
            },
            {
              id: uploadId,
              player: { embedWidth: "1920", embedHeight: "1080" },
            },
            {
              id: historicalId,
              liveStreamingDetails: {
                actualStartTime: "2026-01-01T00:00:00.000Z",
              },
              snippet: { liveBroadcastContent: "none" },
              player: { embedWidth: "1920", embedHeight: "1080" },
            },
            {
              id: portraitOnlyId,
              liveStreamingDetails: {
                actualStartTime: "2026-08-10T22:00:00.000Z",
                actualEndTime: "2026-08-10T23:00:00.000Z",
              },
              player: { embedWidth: "608", embedHeight: "1080" },
            },
          ],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const result = await listYoutubeGameVods("access-secret", fetchImpl, {
      maxPages: 2,
      nowMs: ongoingNow,
      expectedHandle: "@TestCaster",
    });

    expect(result).toMatchObject({
      channelId: "UC9OluGthYmZo0vsF9IjicFg",
      customUrl: "@TestCaster",
      handleLookupAttempted: true,
      handleChannelId: "UC9OluGthYmZo0vsF9IjicFg",
      uploadsScanned: 6,
      pagesFetched: 2,
      videoBatches: 1,
    });
    expect(result.vods).toEqual([
      {
        platform: "youtube",
        videoId: horizontalId,
        startMs: Date.parse("2026-08-10T18:30:00.000Z"),
        endMs: Date.parse("2026-08-10T20:30:00.000Z"),
        orientation: "horizontal",
        ongoing: false,
      },
      {
        platform: "youtube",
        videoId: portraitId,
        startMs: Date.parse("2026-08-10T18:30:08.000Z"),
        endMs: Date.parse("2026-08-10T20:30:00.000Z"),
        orientation: "portrait",
        ongoing: false,
      },
      {
        platform: "youtube",
        videoId: ongoingId,
        startMs: Date.parse("2026-08-10T21:00:00.000Z"),
        endMs: ongoingNow + YOUTUBE_ONGOING_GRACE_MS,
        orientation: "horizontal",
        ongoing: true,
      },
      {
        platform: "youtube",
        videoId: portraitOnlyId,
        startMs: Date.parse("2026-08-10T22:00:00.000Z"),
        endMs: Date.parse("2026-08-10T23:00:00.000Z"),
        orientation: "portrait",
        ongoing: false,
      },
    ]);
    expect(result.vods.some(({ videoId }) => videoId === uploadId)).toBe(false);
    expect(result.vods.some(({ videoId }) => videoId === historicalId))
      .toBe(false);
    const channelCall = calls.find(({ url }) =>
      url.pathname.endsWith("/channels") && url.searchParams.has("mine"));
    expect(channelCall.url.searchParams.get("mine")).toBe("true");
    expect(channelCall.url.searchParams.get("part"))
      .toBe("contentDetails,snippet");
    expect(channelCall.url.searchParams.get("fields")).toContain("uploads");
    const handleCall = calls.find(({ url }) =>
      url.pathname.endsWith("/channels") && url.searchParams.has("forHandle"));
    expect(handleCall.url.searchParams.get("forHandle")).toBe("testcaster");
    expect(handleCall.url.searchParams.get("fields")).toBe("items/id");
    const playlistCalls = calls.filter(({ url }) =>
      url.pathname.endsWith("/playlistItems"));
    expect(playlistCalls).toHaveLength(2);
    expect(playlistCalls[0].url.searchParams.get("maxResults")).toBe("50");
    const videosCall = calls.find(({ url }) => url.pathname.endsWith("/videos"));
    expect(videosCall.url.searchParams.get("maxWidth")).toBe("1920");
    expect(videosCall.url.searchParams.get("maxHeight")).toBe("1080");
    expect(videosCall.url.searchParams.get("part"))
      .toBe("liveStreamingDetails,player,snippet");
    expect(videosCall.url.searchParams.get("fields")).toContain("actualStartTime");
    expect(videosCall.url.searchParams.get("fields"))
      .toContain("liveBroadcastContent");
    expect(calls.every(({ init }) =>
      init.headers.Authorization === "Bearer access-secret")).toBe(true);
    expect(calls.every(({ url }) => !url.toString().includes("access-secret")))
      .toBe(true);
  });
});

describe("GameVodsService", () => {
  test("matches approved non-pro directory channels to broadcasts and never returns a channel-page fallback", async () => {
    const playerChannels = {
      resolve: jest.fn(async (players) => ({ players: players.map((identity) => ({ ...identity, id: "directory-player", displayName: "Creator", channels: { twitch: "https://www.twitch.tv/creator", youtube: "https://www.youtube.com/channel/UC9OluGthYmZo0vsF9IjicFg" } })) })),
    };
    const pulseIntel = { getIntel: jest.fn() };
    const fetchImpl = jest.fn(async (url) => {
      if (String(url).includes("gql.twitch.tv")) return jsonResponse(twitchPayload());
      if (String(url).endsWith("/streams")) return htmlResponse('{"externalId":"UC9OluGthYmZo0vsF9IjicFg","videoId":"AbCdEf12345"}');
      return htmlResponse(youtubeWatchPage());
    });
    const service = new GameVodsService({ users: { getPreferences: async () => ({}) }, playerChannels, pulseIntel, fetchImpl });
    const opponent = { toonHandle: "1-S2-1-12345", displayName: "Creator" };
    const result = await service.resolveForGames("viewer", [
      { gameId: "during", startedAt: "2026-08-10T19:00:00.000Z", opponent },
      { gameId: "outside", startedAt: "2026-08-10T21:00:00.000Z", opponent },
    ], { includeOpponent: true });
    expect(playerChannels.resolve).toHaveBeenCalledWith([{ toonHandle: "1-S2-1-12345" }]);
    expect(pulseIntel.getIntel).not.toHaveBeenCalled();
    expect(result.linksByGameId.during).toEqual([
      expect.objectContaining({ perspective: "opponent", platform: "twitch", url: "https://www.twitch.tv/videos/1234567890?t=1h0m0s", offsetSec: 3600 }),
      expect.objectContaining({ perspective: "opponent", platform: "youtube", url: "https://www.youtube.com/watch?v=AbCdEf12345&t=1800s", offsetSec: 1800 }),
    ]);
    expect(result.linksByGameId.outside).toEqual([]);
    expect(result).not.toHaveProperty("channelsByGameId");
  });

  test("ReSpOnSe's approved toon works as the owner and as another user's opponent", async () => {
    const getPreferences = jest.fn(async () => ({}));
    const playerChannels = { resolve: jest.fn(async (players) => ({ players: players.map((identity) => ({ ...identity, id: "response", displayName: "ReSpOnSe", channels: { twitch: "https://www.twitch.tv/response" } })) })) };
    const fetchImpl = jest.fn(async () => jsonResponse(twitchPayload()));
    const service = new GameVodsService({ users: { getPreferences }, playerChannels, fetchImpl });
    const own = await service.resolveForGames("response-owner", [{ gameId: "mine", startedAt: "2026-08-10T18:05:00.000Z", myToonHandle: "1-S2-1-267727" }]);
    const other = await service.resolveForGames("different-viewer", [{ gameId: "opponent", startedAt: "2026-08-10T18:05:00.000Z", opponent: { toonHandle: "1-S2-1-267727" } }], { includeOpponent: true });
    expect(own.linksByGameId.mine[0]).toMatchObject({ perspective: "me", playerName: "ReSpOnSe", offsetSec: 300 });
    expect(other.linksByGameId.opponent[0]).toMatchObject({ perspective: "opponent", playerName: "ReSpOnSe", offsetSec: 300 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(getPreferences.mock.calls).toEqual([["response-owner", "multichat"], ["different-viewer", "multichat"]]);
  });

  test.each(["removed", "missing", "unavailable"])("directory %s preserves the appropriate Pulse fallback", async (mode) => {
    const playerChannels = { resolve: jest.fn(async (players) => {
      if (mode === "unavailable") throw new Error("directory unavailable");
      return { players: players.map((identity) => ({ ...identity, ...(mode === "removed" ? { id: "removed-entry" } : {}), channels: {} })) };
    }) };
    const pulseIntel = { getIntel: jest.fn(async () => ({ pro: { nickname: "Pro", links: { twitch: "https://www.twitch.tv/proplayer" } } })) };
    const fetchImpl = jest.fn(async () => jsonResponse(twitchPayload()));
    const service = new GameVodsService({ users: { getPreferences: async () => ({}) }, playerChannels, pulseIntel, fetchImpl });
    const result = await service.resolveForGames("viewer", [{ gameId: "game", startedAt: "2026-08-10T19:00:00.000Z", opponent: { pulseCharacterId: "42" } }], { includeOpponent: true });
    expect(pulseIntel.getIntel).toHaveBeenCalledTimes(mode === "removed" ? 0 : 1);
    expect(result.linksByGameId.game).toHaveLength(mode === "removed" ? 0 : 1);
  });

  test("explicit private own-channel preferences retain priority over directory discovery", async () => {
    const playerChannels = { resolve: async (players) => ({ players: players.map((identity) => ({ ...identity, id: "own-entry", channels: { twitch: "https://www.twitch.tv/directorychannel" } })) }) };
    const fetchImpl = jest.fn(async () => jsonResponse(twitchPayload()));
    const service = new GameVodsService({ users: { getPreferences: async () => ({ twitch: { channel: "privatechoice" } }) }, playerChannels, fetchImpl });
    const result = await service.resolveForGames("owner", [{ gameId: "game", startedAt: "2026-08-10T19:00:00.000Z", myToonHandle: "1-S2-1-267727" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].body).toContain("privatechoice");
    expect(fetchImpl.mock.calls[0][1].body).not.toContain("directorychannel");
    expect(result.linksByGameId.game).toHaveLength(1);
  });

  test("directory discovery is bounded and ignores games with no usable start time", async () => {
    const playerChannels = { resolve: jest.fn(async (players) => ({ players: players.map((identity, index) => ({ ...identity, id: String(index + 1), channels: { twitch: `https://www.twitch.tv/creator${index}` } })) })) };
    const fetchImpl = jest.fn(async () => jsonResponse(twitchPayload()));
    const service = new GameVodsService({ users: { getPreferences: async () => ({}) }, playerChannels, fetchImpl });
    const games = Array.from({ length: 50 }, (_, index) => ({ gameId: String(index), startedAt: "2026-08-10T19:00:00.000Z", myToonHandle: `1-S2-1-${100 + index}`, opponent: { toonHandle: `2-S2-1-${100 + index}` } }));
    await service.resolveForGames("viewer", games, { includeOpponent: true });
    expect(playerChannels.resolve).toHaveBeenCalledTimes(1);
    expect(playerChannels.resolve.mock.calls[0][0]).toHaveLength(16);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(16);
    playerChannels.resolve.mockClear();
    await service.resolveForGames("viewer", [{ gameId: "untimed", myToonHandle: "1-S2-1-267727" }], { includeOpponent: true });
    expect(playerChannels.resolve).not.toHaveBeenCalled();
  });

  test("opponent channel discovery stays opt-in", async () => {
    const playerChannels = { resolve: jest.fn() };
    const fetchImpl = jest.fn();
    const service = new GameVodsService({ users: { getPreferences: async () => ({}) }, playerChannels, fetchImpl });
    const result = await service.resolveForGames("viewer", [{ gameId: "game", startedAt: "2026-08-10T19:00:00.000Z", opponent: { toonHandle: "1-S2-1-267727" } }]);
    expect(playerChannels.resolve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.linksByGameId.game).toEqual([]);
  });

  test("uses verified official YouTube archives with the exact game timestamp", async () => {
    const resolveYoutubeGameVods = jest.fn(async () => ({
      channelId: "UC9OluGthYmZo0vsF9IjicFg",
      customUrl: "@TestCaster",
      uploadsScanned: 42,
      pagesFetched: 2,
      videoBatches: 1,
      vods: [{
        platform: "youtube",
        videoId: "AbCdEf12345",
        startMs: Date.parse("2026-08-10T18:30:00.000Z"),
        endMs: Date.parse("2026-08-10T20:30:00.000Z"),
      }],
    }));
    const fetchImpl = jest.fn(async () => {
      throw new Error("public scrape should not run");
    });
    const service = new GameVodsService({
      users: {
        getPreferences: async () => ({ youtube: { channel: "@TestCaster" } }),
      },
      platformIntegrations: { resolveYoutubeGameVods },
      fetchImpl,
    });

    const result = await service.resolveForGames("user-1", [{
      gameId: "g1",
      startedAt: "2026-08-10T19:00:01.500Z",
      date: "2026-08-10T19:20:00.000Z",
      durationSec: 1200,
    }]);

    expect(resolveYoutubeGameVods).toHaveBeenCalledWith("user-1", {
      expectedHandle: "@testcaster",
      expectedRevision: "",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.linksByGameId.g1).toEqual([expect.objectContaining({
      platform: "youtube",
      videoId: "AbCdEf12345",
      offsetSec: 1801,
      url: "https://www.youtube.com/watch?v=AbCdEf12345&t=1801s",
    })]);
  });

  test("invalidates official archive cache when the OAuth revision changes", async () => {
    let revision = "revision-one";
    const resolveYoutubeGameVods = jest.fn(async (_userId, opts) => ({
      channelId: "UC9OluGthYmZo0vsF9IjicFg",
      customUrl: "@TestCaster",
      handleLookupAttempted: true,
      handleChannelId: "UC9OluGthYmZo0vsF9IjicFg",
      vods: [{
        platform: "youtube",
        videoId: opts.expectedRevision === "revision-one"
          ? "First123456"
          : "Secon123456",
        startMs: Date.parse("2026-08-10T18:30:00.000Z"),
        endMs: Date.parse("2026-08-10T20:30:00.000Z"),
        orientation: "horizontal",
      }],
    }));
    const service = new GameVodsService({
      users: {
        getPreferences: async () => ({ youtube: { channel: "@TestCaster" } }),
      },
      platformIntegrations: {
        getYoutubeConnectionRevision: async () => revision,
        resolveYoutubeGameVods,
      },
      fetchImpl: async () => {
        throw new Error("public scrape should not run");
      },
    });
    const games = [{
      gameId: "g1",
      startedAt: "2026-08-10T19:00:00.000Z",
    }];

    const first = await service.resolveForGames("user-1", games);
    revision = "revision-two";
    const second = await service.resolveForGames("user-1", games);

    expect(first.linksByGameId.g1[0].videoId).toBe("First123456");
    expect(second.linksByGameId.g1[0].videoId).toBe("Secon123456");
    expect(resolveYoutubeGameVods).toHaveBeenCalledTimes(2);
    expect(resolveYoutubeGameVods.mock.calls.map((call) =>
      call[1].expectedRevision)).toEqual(["revision-one", "revision-two"]);
  });

  test("never associates archives from a mismatched connected YouTube channel", async () => {
    const service = new GameVodsService({
      users: {
        getPreferences: async () => ({ youtube: { channel: "@TestCaster" } }),
      },
      platformIntegrations: {
        resolveYoutubeGameVods: async () => ({
          channelId: "UCYxRlFDqcWM4y7FfpiAN3KQ",
          customUrl: "@DifferentCaster",
          vods: [{
            platform: "youtube",
            videoId: "Wrong123456",
            startMs: Date.parse("2026-08-10T18:30:00.000Z"),
            endMs: Date.parse("2026-08-10T20:30:00.000Z"),
          }],
        }),
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/@TestCaster/streams")) {
          return htmlResponse(
            '{"externalId":"UC9OluGthYmZo0vsF9IjicFg",' +
              '"videoId":"AbCdEf12345"}',
          );
        }
        return htmlResponse(youtubeWatchPage());
      },
    });

    const result = await service.resolveForGames("user-1", [
      { gameId: "g1", startedAt: "2026-08-10T19:00:00.000Z" },
    ]);

    expect(result.linksByGameId.g1).toEqual([
      expect.objectContaining({ videoId: "AbCdEf12345" }),
    ]);
    expect(result.linksByGameId.g1).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ videoId: "Wrong123456" }),
    ]));
  });

  test("falls back to anonymous scraping when official OAuth lookup fails", async () => {
    const log = { warn: jest.fn(), info: jest.fn() };
    const service = new GameVodsService({
      users: {
        getPreferences: async () => ({ youtube: { channel: "@TestCaster" } }),
      },
      platformIntegrations: {
        resolveYoutubeGameVods: jest.fn(async () => {
          throw Object.assign(
            new Error("provider echoed access-secret-that-must-not-log"),
            { code: "youtube_game_vods_channel", status: 401 },
          );
        }),
      },
      log,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/@TestCaster/streams")) {
          return htmlResponse(
            '{"externalId":"UC9OluGthYmZo0vsF9IjicFg",' +
              '"videoId":"AbCdEf12345"}',
          );
        }
        return htmlResponse(youtubeWatchPage());
      },
    });

    const result = await service.resolveForGames("user-1", [
      { gameId: "g1", startedAt: "2026-08-10T19:00:00.000Z" },
    ]);

    expect(result.linksByGameId.g1).toEqual([
      expect.objectContaining({ platform: "youtube", offsetSec: 1800 }),
    ]);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "youtube",
        source: "public_scrape",
        fallbackReason: "oauth_request_failed",
      }),
      "game_vod_youtube_source_selected",
    );
    expect(JSON.stringify(log.warn.mock.calls))
      .not.toContain("access-secret-that-must-not-log");
  });

  test("falls back to public streams when the bounded OAuth scan is empty", async () => {
    const log = { warn: jest.fn(), info: jest.fn() };
    const service = new GameVodsService({
      users: {
        getPreferences: async () => ({ youtube: { channel: "@TestCaster" } }),
      },
      platformIntegrations: {
        resolveYoutubeGameVods: async () => ({
          channelId: "UC9OluGthYmZo0vsF9IjicFg",
          customUrl: "@TestCaster",
          uploadsScanned: 150,
          pagesFetched: 3,
          videoBatches: 3,
          vods: [],
        }),
      },
      log,
      fetchImpl: async (url) => String(url).endsWith("/@TestCaster/streams")
        ? htmlResponse(
          '{"externalId":"UC9OluGthYmZo0vsF9IjicFg",' +
            '"videoId":"AbCdEf12345"}',
        )
        : htmlResponse(youtubeWatchPage()),
    });

    const result = await service.resolveForGames("user-1", [
      { gameId: "g1", startedAt: "2026-08-10T19:00:00.000Z" },
    ]);

    expect(result.linksByGameId.g1).toEqual([
      expect.objectContaining({ platform: "youtube", videoId: "AbCdEf12345" }),
    ]);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "public_scrape",
        fallbackReason: "oauth_no_livestreams",
        uploadsScanned: 150,
      }),
      "game_vod_youtube_source_selected",
    );
  });

  test("shares one deadline between OAuth discovery and public fallback", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("public fallback should have no time remaining");
    });
    const now = jest.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValue(21_001);
    try {
      const service = new GameVodsService({
        users: {
          getPreferences: async () => ({ youtube: { channel: "@TestCaster" } }),
        },
        platformIntegrations: {
          resolveYoutubeGameVods: async () => {
            throw new Error("official provider timed out");
          },
        },
        fetchImpl,
      });

      const result = await service.resolveForGames("user-1", [{
        gameId: "g1",
        startedAt: "2026-08-10T19:00:00.000Z",
      }]);

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result.linksByGameId.g1).toEqual([]);
    } finally {
      now.mockRestore();
    }
  });

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
