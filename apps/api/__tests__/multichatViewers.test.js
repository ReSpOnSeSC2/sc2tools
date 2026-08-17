// @ts-nocheck
"use strict";

/**
 * Live viewer-count tests.
 *
 * The YouTube extractor runs against REAL captured watch-page bytes
 * (fixtures/youtubeLiveWatchPage.excerpt.html — a live stream showing
 * "1,200 watching now"; fixtures/youtubeVodWatchPage.excerpt.html — a
 * finished video). The live excerpt deliberately keeps the
 * `preloadMessageNames` list that names `videoViewCountRenderer`
 * BEFORE the real renderer appears, because that decoy is exactly
 * what a naive first-match extractor trips over.
 *
 * Twitch/Kick use injected fetch stubs shaped like the real
 * responses; the TikTok path reads the relay's own connection state.
 * No network in CI.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { UsersService } = require("../src/services/users");
const { OverlayTokensService } = require("../src/services/overlayTokens");
const { buildMultichatRouter } = require("../src/routes/multichat");
const {
  MultichatViewersService,
  extractConcurrentViewers,
  toViewerCount,
  TWITCH_JSON_MAX_BYTES,
  KICK_JSON_MAX_BYTES,
  YOUTUBE_PAGE_MAX_BYTES,
} = require("../src/services/multichatViewers");
const { TikTokChatRelay } = require("../src/services/tiktokChatRelay");

const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

const LIVE_PAGE = fixture("youtubeLiveWatchPage.excerpt.html");
const VOD_PAGE = fixture("youtubeVodWatchPage.excerpt.html");

/** Response stub with only what the service reads. */
const jsonRes = (body, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const htmlRes = (html, ok = true, status = 200) => ({
  ok,
  status,
  text: async () => html,
  json: async () => ({}),
});

/**
 * Advertises a response that is too large and exposes spies proving neither
 * text nor JSON parsing was entered before it was rejected.
 */
const declaredOversizeRes = (maxBytes) => {
  const cancel = jest.fn(async () => {});
  const text = jest.fn(async () => {
    throw new Error("oversized body must not be materialized");
  });
  const json = jest.fn(async () => {
    throw new Error("oversized body must not be parsed");
  });
  return {
    response: {
      ok: true,
      status: 200,
      headers: { get: () => String(maxBytes + 1) },
      body: { cancel },
      text,
      json,
    },
    cancel,
    text,
    json,
  };
};

describe("services/multichatViewers — YouTube page extraction", () => {
  test("reads the concurrent count off a real live watch page", () => {
    expect(extractConcurrentViewers(LIVE_PAGE)).toBe(1200);
  });

  test("ignores the preloadMessageNames decoy that precedes the renderer", () => {
    // Guard the actual regression: the bare renderer NAME appears in
    // the page before the renderer itself.
    expect(LIVE_PAGE.indexOf('"videoViewCountRenderer"')).toBeLessThan(
      LIVE_PAGE.search(/"videoViewCountRenderer"\s*:\s*\{/),
    );
    expect(extractConcurrentViewers(LIVE_PAGE)).toBe(1200);
  });

  test("a finished video reports no concurrent viewers (lifetime views are not viewers)", () => {
    expect(extractConcurrentViewers(VOD_PAGE)).toBeNull();
  });

  test("falls back to the locale-formatted runs when originalViewCount is absent", () => {
    const html =
      '{"viewCount":{"videoViewCountRenderer":{"viewCount":{"runs":' +
      '[{"text":"12,345"},{"text":" watching now"}]},"isLive":true}}}';
    expect(extractConcurrentViewers(html)).toBe(12345);
  });

  test("does not mistake lifetime views for current viewers on a live video", () => {
    const html = JSON.stringify({
      viewCount: {
        videoViewCountRenderer: {
          viewCount: { simpleText: "98,765 views" },
          isLive: true,
          originalViewCount: "98765",
        },
      },
    });
    expect(extractConcurrentViewers(html)).toBeNull();
  });

  test("keeps renderer fields isolated and finds a later watching-now count", () => {
    const html = JSON.stringify({
      first: {
        videoViewCountRenderer: {
          viewCount: { simpleText: "98,765 views" },
          originalViewCount: "98765",
        },
      },
      unrelated: { isLive: true },
      second: {
        videoViewCountRenderer: {
          viewCount: {
            runs: [{ text: "14" }, { text: " watching now" }],
          },
          isLive: true,
          originalViewCount: "14",
        },
      },
    });
    expect(extractConcurrentViewers(html)).toBe(14);
  });

  test("a page with no renderer at all is unknown, not zero", () => {
    expect(extractConcurrentViewers("<html>nope</html>")).toBeNull();
  });

  test("toViewerCount rejects junk and floors real numbers", () => {
    expect(toViewerCount("1,204")).toBe(1204);
    expect(toViewerCount(12.7)).toBe(12);
    expect(toViewerCount(-5)).toBeNull();
    expect(toViewerCount("many")).toBeNull();
    expect(toViewerCount(undefined)).toBeNull();
    // Number(null) and Number("") are 0 — never let those through as
    // a real count.
    expect(toViewerCount(null)).toBeNull();
    expect(toViewerCount("")).toBeNull();
  });
});

describe("services/multichatViewers — per-platform lookups", () => {
  test("twitch: a live channel reports its viewersCount", async () => {
    const calls = [];
    const svc = new MultichatViewersService({
      fetchImpl: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return jsonRes({ data: { user: { stream: { viewersCount: 29167 } } } });
      },
    });
    await expect(svc.fetchTwitch("SomeStreamer")).resolves.toEqual({
      platform: "twitch",
      viewers: 29167,
      live: true,
    });
    expect(calls[0].url).toBe("https://gql.twitch.tv/gql");
    expect(calls[0].body.variables).toEqual({ login: "somestreamer" });
  });

  test("twitch: parses the bounded stream exposed by native fetch", async () => {
    const svc = new MultichatViewersService({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: { user: { stream: { viewersCount: 321 } } },
          }),
          { status: 200 },
        ),
    });

    await expect(svc.fetchTwitch("somestreamer")).resolves.toEqual({
      platform: "twitch",
      viewers: 321,
      live: true,
    });
  });

  test("twitch: an offline channel is a truthful zero, an unknown login is not", async () => {
    const offline = new MultichatViewersService({
      fetchImpl: async () => jsonRes({ data: { user: { stream: null } } }),
    });
    await expect(offline.fetchTwitch("somechan")).resolves.toEqual({
      platform: "twitch",
      viewers: 0,
      live: false,
    });

    const unknown = new MultichatViewersService({
      fetchImpl: async () => jsonRes({ data: { user: null } }),
    });
    await expect(unknown.fetchTwitch("somechan")).resolves.toEqual({
      platform: "twitch",
      viewers: null,
      live: false,
    });
  });

  test("twitch: a channel URL is accepted, junk is rejected without a fetch", async () => {
    let fetched = 0;
    const svc = new MultichatViewersService({
      fetchImpl: async (_url, init) => {
        fetched += 1;
        expect(JSON.parse(init.body).variables.login).toBe("somestreamer");
        return jsonRes({ data: { user: { stream: { viewersCount: 7 } } } });
      },
    });
    await expect(
      svc.fetchTwitch("https://twitch.tv/SomeStreamer"),
    ).resolves.toMatchObject({ viewers: 7 });
    await expect(svc.fetchTwitch("not a channel!")).resolves.toEqual({
      platform: "twitch",
      viewers: null,
      live: false,
    });
    expect(fetched).toBe(1);
  });

  test("kick: live channel counts, offline is zero, Cloudflare block is unknown", async () => {
    const live = new MultichatViewersService({
      fetchImpl: async (url) => {
        expect(url).toBe("https://kick.com/api/v2/channels/somekick");
        return jsonRes({ livestream: { is_live: true, viewer_count: 4821 } });
      },
    });
    await expect(live.fetchKick("kick.com/SomeKick")).resolves.toEqual({
      platform: "kick",
      viewers: 4821,
      live: true,
    });

    const offline = new MultichatViewersService({
      fetchImpl: async () => jsonRes({ livestream: null }),
    });
    await expect(offline.fetchKick("somekick")).resolves.toEqual({
      platform: "kick",
      viewers: 0,
      live: false,
    });

    // The documented failure mode of this endpoint from a datacenter
    // IP — it must never become a fake 0 on the dock.
    const blocked = new MultichatViewersService({
      fetchImpl: async () => jsonRes({ error: "blocked" }, false, 403),
    });
    await expect(blocked.lookup("kick", "somekick")).resolves.toEqual({
      platform: "kick",
      viewers: null,
      live: false,
    });
  });

  test("kick: does not substitute an ambiguous views field", async () => {
    const svc = new MultichatViewersService({
      fetchImpl: async () =>
        jsonRes({ livestream: { is_live: true, viewers: 99999 } }),
    });
    await expect(svc.fetchKick("somekick")).resolves.toEqual({
      platform: "kick",
      viewers: null,
      live: false,
    });
  });

  test("youtube: resolves a handle's /live page, then the count", async () => {
    const urls = [];
    const svc = new MultichatViewersService({
      fetchImpl: async (url) => {
        urls.push(url);
        return htmlRes(LIVE_PAGE);
      },
    });
    await expect(svc.fetchYoutube("@SomeChannel")).resolves.toEqual({
      platform: "youtube",
      viewers: 1200,
      live: true,
    });
    expect(urls).toEqual(["https://www.youtube.com/@SomeChannel/live"]);
  });

  test("youtube: a channel that isn't streaming reports zero", async () => {
    const svc = new MultichatViewersService({
      fetchImpl: async () => htmlRes(VOD_PAGE),
    });
    await expect(svc.fetchYoutube("@SomeChannel")).resolves.toEqual({
      platform: "youtube",
      viewers: 0,
      live: false,
    });
  });

  test("youtube: a live stream with its current count hidden stays unknown", async () => {
    const page = JSON.stringify({
      viewCount: {
        videoViewCountRenderer: {
          viewCount: { simpleText: "98,765 views" },
          isLive: true,
          originalViewCount: "98765",
        },
      },
    });
    const svc = new MultichatViewersService({
      fetchImpl: async () => htmlRes(page),
    });
    await expect(svc.fetchYoutube("@SomeChannel")).resolves.toEqual({
      platform: "youtube",
      viewers: null,
      live: false,
    });
  });

  test("tiktok: read off the relay connection, unknown when nothing is attached", async () => {
    const relay = {
      viewerCount: (username) => (username === "livestreamer" ? 640 : null),
    };
    const svc = new MultichatViewersService({ tiktokRelay: relay });
    await expect(svc.readTikTok("livestreamer")).resolves.toEqual({
      platform: "tiktok",
      viewers: 640,
      live: true,
    });
    await expect(svc.readTikTok("nobody")).resolves.toEqual({
      platform: "tiktok",
      viewers: null,
      live: false,
    });
  });

  test("an upstream throw degrades to unknown instead of failing the request", async () => {
    const svc = new MultichatViewersService({
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    });
    await expect(svc.lookup("twitch", "somechan")).resolves.toEqual({
      platform: "twitch",
      viewers: null,
      live: false,
    });
  });

  test("a transient non-success response is cancelled and degrades to unknown", async () => {
    const cancel = jest.fn(async () => {});
    const svc = new MultichatViewersService({
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        body: { cancel },
      }),
    });

    await expect(svc.lookup("kick", "somekick")).resolves.toEqual({
      platform: "kick",
      viewers: null,
      live: false,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["twitch", TWITCH_JSON_MAX_BYTES, "somechan"],
    ["kick", KICK_JSON_MAX_BYTES, "somekick"],
  ])(
    "%s: rejects an oversized declared JSON body before materializing or parsing it",
    async (platform, maxBytes, channel) => {
      const oversized = declaredOversizeRes(maxBytes);
      const svc = new MultichatViewersService({
        fetchImpl: async () => oversized.response,
      });

      const result = await svc.lookup(platform, channel);

      expect(result).toEqual({ platform, viewers: null, live: false });
      expect(oversized.cancel).toHaveBeenCalledTimes(1);
      expect(oversized.text).not.toHaveBeenCalled();
      expect(oversized.json).not.toHaveBeenCalled();
    },
  );

  test("youtube: rejects an oversized declared page before reading it and fails soft", async () => {
    const oversized = declaredOversizeRes(YOUTUBE_PAGE_MAX_BYTES);
    const svc = new MultichatViewersService({
      fetchImpl: async () => oversized.response,
    });

    await expect(svc.lookup("youtube", "@SomeChannel")).resolves.toEqual({
      platform: "youtube",
      viewers: null,
      live: false,
    });
    expect(oversized.cancel).toHaveBeenCalledTimes(1);
    expect(oversized.text).not.toHaveBeenCalled();
  });

  test("chunked JSON is cancelled as soon as its decompressed stream crosses the cap", async () => {
    const chunk = new Uint8Array(Math.floor(TWITCH_JSON_MAX_BYTES / 2) + 1);
    let reads = 0;
    const cancel = jest.fn(async () => {});
    const reader = {
      read: jest.fn(async () => {
        reads += 1;
        return { done: false, value: chunk };
      }),
      cancel,
      releaseLock: jest.fn(),
    };
    const svc = new MultichatViewersService({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: { getReader: () => reader },
      }),
    });

    await expect(svc.lookup("twitch", "somechan")).resolves.toEqual({
      platform: "twitch",
      viewers: null,
      live: false,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(reads).toBe(2);
  });

  test("chunked YouTube HTML is cancelled before the oversized page is inspected", async () => {
    const chunk = new Uint8Array(Math.floor(YOUTUBE_PAGE_MAX_BYTES / 2) + 1);
    let reads = 0;
    const cancel = jest.fn(async () => {});
    const reader = {
      read: jest.fn(async () => {
        reads += 1;
        return { done: false, value: chunk };
      }),
      cancel,
      releaseLock: jest.fn(),
    };
    const svc = new MultichatViewersService({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: { getReader: () => reader },
      }),
    });

    await expect(svc.lookup("youtube", "@SomeChannel")).resolves.toEqual({
      platform: "youtube",
      viewers: null,
      live: false,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(reads).toBe(2);
  });
});

describe("services/multichatViewers — caching and totals", () => {
  test("observation time is response completion, not request start", async () => {
    let now = 1_000_000;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const svc = new MultichatViewersService({
      now: () => now,
      fetchImpl: async () => {
        await gate;
        return jsonRes({ data: { user: { stream: { viewersCount: 42 } } } });
      },
    });

    const pending = svc.forConfig({
      twitch: { enabled: true, channel: "somechan" },
    });
    now = 1_000_250;
    release();
    const result = await pending;
    expect(result.platforms[0].observedAtMs).toBe(1_000_250);
  });

  test("forConfig exposes the real cached observation time, not response time", async () => {
    let now = 1_000_000;
    const svc = new MultichatViewersService({
      ttlMs: 20_000,
      now: () => now,
      fetchImpl: async () =>
        jsonRes({ data: { user: { stream: { viewersCount: 10 } } } }),
    });
    const config = { twitch: { enabled: true, channel: "somechan" } };

    const first = await svc.forConfig(config);
    expect(first.platforms[0].observedAtMs).toBe(1_000_000);

    now += 5_000;
    const cached = await svc.forConfig(config);
    expect(cached.atMs).toBe(1_005_000);
    expect(cached.platforms[0].observedAtMs).toBe(1_000_000);

    now += 20_001;
    const refreshed = await svc.forConfig(config);
    expect(refreshed.platforms[0].observedAtMs).toBe(1_025_001);
  });

  test("repeat lookups inside the TTL hit cache; concurrent ones share one fetch", async () => {
    let fetches = 0;
    let now = 1_000_000;
    const svc = new MultichatViewersService({
      ttlMs: 20_000,
      now: () => now,
      fetchImpl: async () => {
        fetches += 1;
        return jsonRes({ data: { user: { stream: { viewersCount: 10 } } } });
      },
    });

    // Two docks polling at the same instant = one upstream call.
    await Promise.all([
      svc.lookup("twitch", "somechan"),
      svc.lookup("twitch", "somechan"),
    ]);
    expect(fetches).toBe(1);

    await svc.lookup("twitch", "SOMECHAN");
    expect(fetches).toBe(1);

    now += 20_001;
    await svc.lookup("twitch", "somechan");
    expect(fetches).toBe(2);
  });

  test("a refreshed current count can decrease", async () => {
    let now = 1_000_000;
    let current = 640;
    const svc = new MultichatViewersService({
      ttlMs: 20_000,
      now: () => now,
      fetchImpl: async () =>
        jsonRes({ data: { user: { stream: { viewersCount: current } } } }),
    });

    await expect(svc.lookup("twitch", "somechan")).resolves.toMatchObject({
      viewers: 640,
    });
    current = 12;
    now += 20_001;
    await expect(svc.lookup("twitch", "somechan")).resolves.toMatchObject({
      viewers: 12,
    });
  });

  test("forConfig totals the enabled platforms and skips the rest", async () => {
    const svc = new MultichatViewersService({
      tiktokRelay: { viewerCount: () => 300 },
      fetchImpl: async (url) => {
        if (String(url).includes("gql.twitch.tv")) {
          return jsonRes({ data: { user: { stream: { viewersCount: 1200 } } } });
        }
        if (String(url).includes("kick.com")) {
          return jsonRes({ livestream: { is_live: true, viewer_count: 50 } });
        }
        return htmlRes(LIVE_PAGE);
      },
    });

    const out = await svc.forConfig({
      twitch: { enabled: true, channel: "somechan" },
      kick: { enabled: true, channel: "somekick" },
      youtube: { enabled: false, channel: "@some" },
      tiktok: { enabled: true, username: "someone" },
    });

    expect(out.platforms.map((p) => p.platform).sort()).toEqual([
      "kick",
      "tiktok",
      "twitch",
    ]);
    expect(out.total).toBe(1550);
    expect(out.partial).toBe(false);
  });

  test("an unreachable platform is flagged partial and left out of the total", async () => {
    const svc = new MultichatViewersService({
      fetchImpl: async (url) =>
        String(url).includes("kick.com")
          ? jsonRes({}, false, 403)
          : jsonRes({ data: { user: { stream: { viewersCount: 800 } } } }),
    });
    const out = await svc.forConfig({
      twitch: { enabled: true, channel: "somechan" },
      kick: { enabled: true, channel: "somekick" },
    });
    expect(out.total).toBe(800);
    expect(out.partial).toBe(true);
    expect(out.platforms.find((p) => p.platform === "kick").viewers).toBeNull();
  });

  test("an empty config asks the platforms nothing", async () => {
    let fetches = 0;
    const svc = new MultichatViewersService({
      fetchImpl: async () => {
        fetches += 1;
        return jsonRes({});
      },
    });
    const out = await svc.forConfig(null);
    expect(out).toMatchObject({ platforms: [], total: 0, partial: false });
    expect(fetches).toBe(0);
  });

  test("the result cache is a bounded LRU and evicted channels refetch", async () => {
    const calls = new Map();
    const svc = new MultichatViewersService({
      maxCacheEntries: 2,
      fetchImpl: async (_url, init) => {
        const login = JSON.parse(init.body).variables.login;
        calls.set(login, (calls.get(login) || 0) + 1);
        return jsonRes({ data: { user: { stream: { viewersCount: 1 } } } });
      },
    });

    await svc.lookup("twitch", "alpha");
    await svc.lookup("twitch", "bravo");
    await svc.lookup("twitch", "alpha"); // refresh alpha's LRU position
    await svc.lookup("twitch", "charlie"); // evicts bravo
    await svc.lookup("twitch", "bravo");

    expect(calls.get("alpha")).toBe(1);
    expect(calls.get("charlie")).toBe(1);
    expect(calls.get("bravo")).toBe(2);
    expect(svc.cache.size).toBe(2);
  });

  test("distinct lookup bursts are shed at the in-flight cap without caching the transient unknown", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let fetches = 0;
    const svc = new MultichatViewersService({
      maxInFlight: 1,
      fetchImpl: async () => {
        fetches += 1;
        await gate;
        return jsonRes({ data: { user: { stream: { viewersCount: 12 } } } });
      },
    });

    const first = svc.lookup("twitch", "alpha");
    await expect(svc.lookup("twitch", "bravo")).resolves.toEqual({
      platform: "twitch",
      viewers: null,
      live: false,
    });
    expect(fetches).toBe(1);
    expect(svc.inFlight.size).toBe(1);

    release();
    await expect(first).resolves.toMatchObject({ viewers: 12 });
    await expect(svc.lookup("twitch", "bravo")).resolves.toMatchObject({
      viewers: 12,
    });
    expect(fetches).toBe(2);
  });

  test("identical lookups coalesce, while attached callers remain bounded", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let fetches = 0;
    const svc = new MultichatViewersService({
      maxSubscribersPerLookup: 2,
      fetchImpl: async () => {
        fetches += 1;
        await gate;
        return jsonRes({ data: { user: { stream: { viewersCount: 9 } } } });
      },
    });

    const first = svc.lookup("twitch", "alpha");
    const second = svc.lookup("twitch", "alpha");
    await expect(svc.lookup("twitch", "alpha")).resolves.toEqual({
      platform: "twitch",
      viewers: null,
      live: false,
    });
    expect(fetches).toBe(1);
    expect(svc.capacitySnapshot()).toMatchObject({
      inflightRequests: 1,
      subscribers: 2,
      maxSubscribersPerRequest: 2,
    });

    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { platform: "twitch", viewers: 9, live: true },
      { platform: "twitch", viewers: 9, live: true },
    ]);
    expect(svc.capacitySnapshot()).toMatchObject({
      cacheEntries: 1,
      inflightRequests: 0,
      subscribers: 0,
    });
  });
});

describe("services/tiktokChatRelay — viewer count", () => {
  /** Minimal connector double: captures handlers, fires them on demand. */
  function fakeConnection() {
    const handlers = new Map();
    return {
      handlers,
      on: (name, fn) => handlers.set(name, fn),
      connect: async () => ({}),
      disconnect: () => {},
      fire: (name, data) => handlers.get(name)?.(data),
    };
  }

  test("tracks only the current roomUser audience and forgets it after", async () => {
    let conn;
    const relay = new TikTokChatRelay({
      connectionFactory: async () => {
        conn = fakeConnection();
        return conn;
      },
    });
    const off = relay.subscribe("someone", () => {});
    // Let connectOnce() finish attaching handlers + connecting.
    await new Promise((r) => setImmediate(r));

    expect(relay.viewerCount("someone")).toBeNull();
    conn.fire("roomUser", { viewerCount: 512, total: 500, totalUser: 640 });
    expect(relay.viewerCount("someone")).toBe(512);
    // Production's raw protobuf path: `total` is concurrent while
    // `totalUser` is the cumulative unique audience.
    conn.fire("roomUser", { total: "37", totalUser: "4812" });
    expect(relay.viewerCount("someone")).toBe(37);
    conn.fire("roomUser", { viewerCount: "", total: "21", totalUser: "5000" });
    expect(relay.viewerCount("someone")).toBe(21);
    // Current snapshots are allowed to go down; they are not a running
    // total or a high-water mark.
    conn.fire("roomUser", { viewerCount: 12, total: 9000, totalUser: 9999 });
    expect(relay.viewerCount("someone")).toBe(12);
    // A cumulative-only payload is not a truthful current count.
    conn.fire("roomUser", { totalUser: 10000 });
    expect(relay.viewerCount("someone")).toBeNull();

    // A stream that ended must not keep quoting its last count.
    conn.fire("streamEnd");
    expect(relay.viewerCount("someone")).toBeNull();

    off();
    expect(relay.viewerCount("someone")).toBeNull();
    expect(relay.viewerCount("never-subscribed")).toBeNull();
    expect(relay.viewerCount("bad name!")).toBeNull();
  });
});

describe("GET /v1/multichat/:token/viewers", () => {
  let mongo;
  let db;
  let app;
  let users;
  let token;
  let userId;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "multichat_viewers_test" });
    users = new UsersService(db, {});
    const overlayTokens = new OverlayTokensService(db);
    userId = (await users.ensureFromClerk("user_viewers")).userId;
    token = (await overlayTokens.create(userId, "test")).token;

    app = express();
    app.use(express.json());
    app.use(
      "/v1",
      buildMultichatRouter({
        overlayTokens,
        users,
        tiktokRelay: new TikTokChatRelay({
          connectionFactory: async () => ({
            on() {},
            connect: async () => ({}),
            disconnect() {},
          }),
        }),
        viewers: new MultichatViewersService({
          tiktokRelay: { viewerCount: () => null },
          fetchImpl: async (url) =>
            String(url).includes("gql.twitch.tv")
              ? jsonRes({ data: { user: { stream: { viewersCount: 2048 } } } })
              : jsonRes({}, false, 403),
        }),
      }),
    );
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  test("rejects unknown tokens before touching any platform", async () => {
    const res = await request(app).get("/v1/multichat/not-a-token/viewers");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_overlay_token");
  });

  test("serves counts for the streamer's own configured platforms", async () => {
    await users.updatePreferences(userId, "multichat", {
      twitch: { enabled: true, channel: "somechan" },
      kick: { enabled: true, channel: "somekick" },
      tiktok: { enabled: true, username: "someone" },
    });

    const res = await request(app).get(`/v1/multichat/${token}/viewers`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2048);
    expect(res.body.partial).toBe(true);

    const byPlatform = Object.fromEntries(
      res.body.platforms.map((p) => [p.platform, p]),
    );
    expect(byPlatform.twitch).toMatchObject({ viewers: 2048, live: true });
    // Blocked upstream / no live relay connection — unknown, not zero.
    expect(byPlatform.kick.viewers).toBeNull();
    expect(byPlatform.tiktok.viewers).toBeNull();
  });

  test("an unconfigured streamer gets an empty, honest payload", async () => {
    await users.updatePreferences(userId, "multichat", {
      twitch: { enabled: false, channel: "" },
      kick: { enabled: false },
      tiktok: { enabled: false },
    });
    const res = await request(app).get(`/v1/multichat/${token}/viewers`);
    expect(res.status).toBe(200);
    expect(res.body.platforms).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});
