// @ts-nocheck
"use strict";

/**
 * Multichat relay tests.
 *
 * The YouTube parser is exercised against a REAL captured
 * `get_live_chat` response (fixtures/youtubeLiveChatPoll.json —
 * fetched live from youtube.com during development, 27 real text
 * messages). Kick/HTTP paths use injected fetch stubs; the TikTok
 * relay uses an injected connection factory — no network in CI.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { UsersService } = require("../src/services/users");
const { OverlayTokensService } = require("../src/services/overlayTokens");
const {
  buildMultichatRouter,
  sanitizeMultichatConfig,
} = require("../src/routes/multichat");
const yt = require("../src/services/youtubeLiveChat");
const kick = require("../src/services/kickChannel");
const {
  TikTokChatRelay,
  normalizeTikTokUsername,
  mapChatEvent,
  mapTikTokEvent,
} = require("../src/services/tiktokChatRelay");

const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "youtubeLiveChatPoll.json"),
    "utf8",
  ),
);

describe("services/youtubeLiveChat", () => {
  test("parses a real innertube poll response into slim messages", () => {
    const out = yt.parseLiveChatResponse(FIXTURE);
    expect(out.done).toBe(false);
    expect(typeof out.continuation).toBe("string");
    expect(out.continuation.length).toBeGreaterThan(20);
    expect(out.timeoutMs).toBeGreaterThanOrEqual(1500);
    expect(out.timeoutMs).toBeLessThanOrEqual(10000);
    expect(out.messages.length).toBeGreaterThanOrEqual(20);
    for (const m of out.messages) {
      expect(typeof m.id).toBe("string");
      expect(m.id.length).toBeGreaterThan(0);
      expect(typeof m.user).toBe("string");
      expect(m.user.length).toBeGreaterThan(0);
      expect(typeof m.text).toBe("string");
      expect(m.text.length).toBeGreaterThan(0);
      expect(Array.isArray(m.badges)).toBe(true);
      expect(Number.isFinite(m.atMs)).toBe(true);
    }
    // Dedup contract: ids unique within a poll.
    expect(new Set(out.messages.map((m) => m.id)).size).toBe(
      out.messages.length,
    );
    // Events ride alongside without disturbing the message contract.
    expect(Array.isArray(out.events)).toBe(true);
  });

  test("ended stream (no continuationContents) reports done", () => {
    const out = yt.parseLiveChatResponse({});
    expect(out.done).toBe(true);
    expect(out.continuation).toBeNull();
    expect(out.messages).toEqual([]);
    expect(out.events).toEqual([]);
  });

  test("membership + Super Chat renderers become events, not messages", () => {
    const out = yt.parseLiveChatResponse({
      continuationContents: {
        liveChatContinuation: {
          continuations: [
            {
              invalidationContinuationData: {
                continuation: "NEXT_TOKEN_CCCCCCCCCCCCCCCCCCCC",
                timeoutMs: 5000,
              },
            },
          ],
          actions: [
            {
              addChatItemAction: {
                item: {
                  liveChatMembershipItemRenderer: {
                    id: "member-1",
                    timestampUsec: "1768686000000000",
                    authorName: { simpleText: "NewMember" },
                    headerSubtext: {
                      runs: [{ text: "Welcome to " }, { text: "Members!" }],
                    },
                    authorBadges: [],
                  },
                },
              },
            },
            {
              addChatItemAction: {
                item: {
                  liveChatPaidMessageRenderer: {
                    id: "paid-1",
                    timestampUsec: "1768686001000000",
                    authorName: { simpleText: "BigTipper" },
                    purchaseAmountText: { simpleText: "$5.00" },
                    message: {
                      runs: [{ text: "great game " }, { emoji: { shortcuts: [":fire:"] } }],
                    },
                  },
                },
              },
            },
            {
              addChatItemAction: {
                item: {
                  liveChatPaidMessageRenderer: {
                    id: "paid-2",
                    timestampUsec: "1768686002000000",
                    authorName: { simpleText: "QuietTipper" },
                    purchaseAmountText: { simpleText: "€2.00" },
                  },
                },
              },
            },
          ],
        },
      },
    });
    expect(out.messages).toEqual([]);
    expect(out.events).toEqual([
      {
        id: "member-1",
        kind: "member",
        user: "NewMember",
        detail: "Welcome to Members!",
        atMs: 1768686000000,
      },
      {
        id: "paid-1",
        kind: "superchat",
        user: "BigTipper",
        detail: "great game :fire:",
        amount: "$5.00",
        atMs: 1768686001000,
      },
      {
        id: "paid-2",
        kind: "superchat",
        user: "QuietTipper",
        detail: "sent a Super Chat",
        amount: "€2.00",
        atMs: 1768686002000,
      },
    ]);
    expect(out.continuation).toBe("NEXT_TOKEN_CCCCCCCCCCCCCCCCCCCC");
  });

  test("normalizeYoutubeInput handles every supported paste shape", () => {
    expect(yt.normalizeYoutubeInput("dQw4w9WgXcQ")).toEqual({
      videoId: "dQw4w9WgXcQ",
      pageUrls: [],
    });
    expect(
      yt.normalizeYoutubeInput("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).toEqual({ videoId: "dQw4w9WgXcQ", pageUrls: [] });
    expect(yt.normalizeYoutubeInput("https://youtu.be/dQw4w9WgXcQ")).toEqual({
      videoId: "dQw4w9WgXcQ",
      pageUrls: [],
    });
    expect(
      yt.normalizeYoutubeInput("https://www.youtube.com/live/dQw4w9WgXcQ"),
    ).toEqual({ videoId: "dQw4w9WgXcQ", pageUrls: [] });
    expect(yt.normalizeYoutubeInput("@LofiGirl")).toEqual({
      videoId: null,
      pageUrls: ["https://www.youtube.com/@LofiGirl/live"],
    });
    expect(yt.normalizeYoutubeInput("LofiGirl").pageUrls).toEqual([
      "https://www.youtube.com/@LofiGirl/live",
    ]);
    expect(
      yt.normalizeYoutubeInput("https://www.youtube.com/@LofiGirl"),
    ).toEqual({
      videoId: null,
      pageUrls: ["https://www.youtube.com/@LofiGirl/live"],
    });
    expect(() => yt.normalizeYoutubeInput("")).toThrow(yt.YoutubeChatError);
    expect(() => yt.normalizeYoutubeInput("https://vimeo.com/x")).toThrow(
      yt.YoutubeChatError,
    );
  });

  test("resolveLiveChat walks page → chat page → continuation", async () => {
    const pages = {
      "https://www.youtube.com/@Some/live":
        '{"videoId":"abcABC12345"} "isLive":true',
      // Popout page: first continuation is Top chat, LAST is all-messages.
      "https://www.youtube.com/live_chat?is_popout=1&v=abcABC12345":
        '"clientVersion":"2.20260101.00.00" "continuation":"TOPCHAT_TOKEN_AAAAAAAAAAAA" "continuation":"ALLCHAT_TOKEN_BBBBBBBBBBBB"',
    };
    const fetchImpl = async (url) => ({
      ok: true,
      status: 200,
      text: async () => pages[url] ?? "",
    });
    const out = await yt.resolveLiveChat("@Some", { fetchImpl });
    expect(out.videoId).toBe("abcABC12345");
    expect(out.continuation).toBe("ALLCHAT_TOKEN_BBBBBBBBBBBB");
    expect(out.clientVersion).toBe("2.20260101.00.00");
  });

  test("resolveLiveChat reports not_live for an offline channel", async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => '{"videoId":"abcABC12345"}',
    });
    await expect(
      yt.resolveLiveChat("@Offline", { fetchImpl }),
    ).rejects.toMatchObject({ code: "not_live" });
  });

  test("runsToText renders emoji runs as shortcuts", () => {
    expect(
      yt.runsToText([
        { text: "gg " },
        { emoji: { shortcuts: [":fire:"], emojiId: "x" } },
        { text: " wp" },
      ]),
    ).toBe("gg :fire: wp");
  });
});

describe("services/kickChannel", () => {
  test("normalizeKickSlug accepts names and URLs", () => {
    expect(kick.normalizeKickSlug("XQC")).toBe("xqc");
    expect(kick.normalizeKickSlug("https://kick.com/xqc")).toBe("xqc");
    expect(kick.normalizeKickSlug("kick.com/xqc?tab=chat")).toBe("xqc");
    expect(() => kick.normalizeKickSlug("")).toThrow(kick.KickResolveError);
    expect(() => kick.normalizeKickSlug("bad slug!!")).toThrow(
      kick.KickResolveError,
    );
  });

  test("resolveKickChatroom returns the chatroom id from v2", async () => {
    const fetchImpl = async (url) => {
      expect(url).toContain("/api/v2/channels/somestreamer");
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 1, slug: "somestreamer", chatroom: { id: 4242 } }),
      };
    };
    await expect(
      kick.resolveKickChatroom("SomeStreamer", { fetchImpl }),
    ).resolves.toEqual({ slug: "somestreamer", chatroomId: 4242 });
  });

  test("Cloudflare 403 on both versions → structured kick_blocked", async () => {
    const fetchImpl = async () => ({ ok: false, status: 403 });
    await expect(
      kick.resolveKickChatroom("someone", { fetchImpl }),
    ).rejects.toMatchObject({ code: "kick_blocked" });
  });

  test("404 → not_found (channel truly absent)", async () => {
    const fetchImpl = async () => ({ ok: false, status: 404 });
    await expect(
      kick.resolveKickChatroom("nobody", { fetchImpl }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("services/tiktokChatRelay", () => {
  function fakeConnection() {
    const handlers = {};
    return {
      handlers,
      on(event, fn) {
        (handlers[event] = handlers[event] || []).push(fn);
      },
      emit(event, data) {
        for (const fn of handlers[event] || []) fn(data);
      },
      connect: jest.fn().mockResolvedValue({ roomId: "r1" }),
      disconnect: jest.fn(),
    };
  }

  test("normalizeTikTokUsername handles @, URLs, and rejects junk", () => {
    expect(normalizeTikTokUsername("@SomeUser")).toBe("someuser");
    expect(normalizeTikTokUsername("https://www.tiktok.com/@someuser/live")).toBe(
      "someuser",
    );
    expect(() => normalizeTikTokUsername("")).toThrow();
    expect(() => normalizeTikTokUsername("bad name!")).toThrow();
  });

  test("subscribe connects upstream, fans out chat, tears down on last leave", async () => {
    const conn = fakeConnection();
    const relay = new TikTokChatRelay({
      connectionFactory: async () => conn,
    });
    const seenA = [];
    const seenB = [];
    const offA = relay.subscribe("streamer", (e) => seenA.push(e));
    const offB = relay.subscribe("@Streamer", (e) => seenB.push(e));
    expect(relay.size).toBe(1); // same channel, one upstream

    await new Promise((r) => setImmediate(r));
    expect(conn.connect).toHaveBeenCalledTimes(1);
    expect(seenA.some((e) => e.type === "status" && e.state === "connected")).toBe(true);

    conn.emit("chat", {
      comment: "hello from tiktok",
      user: { uniqueId: "viewer1", isModerator: true },
      msgId: "m1",
    });
    const chatA = seenA.find((e) => e.type === "chat");
    expect(chatA.message).toMatchObject({
      id: "m1",
      user: "viewer1",
      text: "hello from tiktok",
      badges: ["moderator"],
    });
    expect(seenB.find((e) => e.type === "chat")).toBeTruthy();

    offA();
    expect(relay.size).toBe(1);
    offB();
    expect(relay.size).toBe(0);
    expect(conn.disconnect).toHaveBeenCalled();
  });

  test("offline streamer surfaces status=offline and keeps the channel for retry", async () => {
    const conn = fakeConnection();
    conn.connect = jest
      .fn()
      .mockRejectedValue(new Error("The requested user isn't online :("));
    const relay = new TikTokChatRelay({ connectionFactory: async () => conn });
    const seen = [];
    const off = relay.subscribe("sleepy", (e) => seen.push(e));
    await new Promise((r) => setImmediate(r));
    expect(seen.some((e) => e.type === "status" && e.state === "offline")).toBe(true);
    expect(relay.size).toBe(1);
    off();
  });

  test("global cap rejects with relay_at_capacity", async () => {
    const relay = new TikTokChatRelay({
      maxChannels: 1,
      connectionFactory: async () => fakeConnection(),
    });
    const off = relay.subscribe("one", () => {});
    expect(() => relay.subscribe("two", () => {})).toThrow(
      expect.objectContaining({ code: "relay_at_capacity" }),
    );
    off();
  });

  test("mapChatEvent drops empty comments and caps length", () => {
    expect(mapChatEvent({ comment: "   " })).toBeNull();
    const long = mapChatEvent({ comment: "x".repeat(900), uniqueId: "u" });
    expect(long.text.length).toBe(500);
  });

  test("mapTikTokEvent maps gifts with streak suppression", () => {
    // Streak-capable gift mid-combo: suppressed.
    expect(
      mapTikTokEvent("gift", {
        giftType: 1,
        repeatEnd: false,
        repeatCount: 3,
        giftName: "Rose",
        user: { uniqueId: "fan1" },
      }),
    ).toBeNull();
    // Same gift at combo end: emitted with the final count.
    expect(
      mapTikTokEvent("gift", {
        giftType: 1,
        repeatEnd: true,
        repeatCount: 3,
        giftName: "Rose",
        user: { uniqueId: "fan1" },
        msgId: "g1",
      }),
    ).toEqual({
      id: "g1",
      kind: "gift",
      user: "fan1",
      detail: "sent Rose x3",
      amount: "3",
      atMs: expect.any(Number),
    });
    // Non-streak gift emits immediately; absent fields still emit.
    expect(
      mapTikTokEvent("gift", { giftType: 5, giftName: "Galaxy", uniqueId: "fan2" }),
    ).toMatchObject({ kind: "gift", user: "fan2", detail: "sent Galaxy", amount: "1" });
    expect(mapTikTokEvent("gift", {})).toMatchObject({
      kind: "gift",
      user: "viewer",
      detail: "sent a gift",
    });
  });

  test("mapTikTokEvent maps follow/subscribe and drops unknown names", () => {
    expect(
      mapTikTokEvent("follow", { user: { uniqueId: "newfan" } }),
    ).toMatchObject({ kind: "follow", user: "newfan", detail: "followed" });
    expect(
      mapTikTokEvent("subscribe", { uniqueId: "supporter" }),
    ).toMatchObject({ kind: "sub", user: "supporter", detail: "subscribed" });
    expect(mapTikTokEvent("like", { uniqueId: "x" })).toBeNull();
  });

  test("gift/follow/subscribe events fan out over the relay", async () => {
    const conn = fakeConnection();
    const relay = new TikTokChatRelay({ connectionFactory: async () => conn });
    const seen = [];
    const off = relay.subscribe("gifty", (e) => seen.push(e));
    await new Promise((r) => setImmediate(r));
    conn.emit("gift", {
      giftType: 5,
      giftName: "Galaxy",
      user: { uniqueId: "fan" },
      msgId: "g2",
    });
    conn.emit("follow", { user: { uniqueId: "newfan" } });
    const events = seen.filter((e) => e.type === "event").map((e) => e.event);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "gift", id: "g2", user: "fan" });
    expect(events[1]).toMatchObject({ kind: "follow", user: "newfan" });
    off();
  });
});

describe("routes/multichat", () => {
  let mongo;
  let db;
  let users;
  let overlayTokens;
  let userId;
  let token;
  let app;
  let relay;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "multichat_test" });
    users = new UsersService(db, {});
    overlayTokens = new OverlayTokensService(db);
    userId = (await users.ensureFromClerk("user_mc")).userId;
    const created = await overlayTokens.create(userId, "test");
    token = created.token;
    relay = new TikTokChatRelay({
      connectionFactory: async () => {
        const conn = {
          on() {},
          connect: async () => ({}),
          disconnect() {},
        };
        return conn;
      },
    });
    app = express();
    app.use(express.json());
    app.use(
      "/v1",
      buildMultichatRouter({
        overlayTokens,
        users,
        tiktokRelay: relay,
        fetchImpl: async () => ({ ok: false, status: 500 }),
      }),
    );
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  test("rejects unknown tokens with 401", async () => {
    const res = await request(app).get("/v1/multichat/not-a-token/config");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_overlay_token");
  });

  test("serves the sanitized multichat config for a valid token", async () => {
    await users.updatePreferences(userId, "multichat", {
      twitch: { enabled: true, channel: "somechan" },
      kick: { enabled: true, channel: "somekick", chatroomId: 777 },
      youtube: { enabled: false, channel: "@some" },
      tiktok: { enabled: true, username: "someone" },
      evil: { enabled: true, script: "<img onerror>" },
    });
    const res = await request(app).get(`/v1/multichat/${token}/config`);
    expect(res.status).toBe(200);
    expect(res.body.config).toEqual({
      twitch: { enabled: true, channel: "somechan" },
      kick: { enabled: true, channel: "somekick", chatroomId: 777 },
      youtube: { enabled: false, channel: "@some" },
      tiktok: { enabled: true, username: "someone" },
    });
  });

  test("youtube resolve surfaces structured upstream errors", async () => {
    const res = await request(app).get(
      `/v1/multichat/${token}/youtube/resolve?channel=@whoever`,
    );
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("upstream");
  });

  test("youtube poll validates input", async () => {
    const res = await request(app)
      .post(`/v1/multichat/${token}/youtube/poll`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_input");
  });

  test("kick resolve reports the blocked case as 502 kick_blocked", async () => {
    const res = await request(app).get(
      `/v1/multichat/${token}/kick/resolve?slug=whoever`,
    );
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("kick_blocked");
  });

  test("tiktok stream rejects bad usernames inside the SSE body", async () => {
    const res = await request(app)
      .get(`/v1/multichat/${token}/tiktok/stream?username=bad name!`)
      .buffer(true)
      .parse((r, cb) => {
        let data = "";
        r.on("data", (c) => (data += c));
        r.on("end", () => cb(null, data));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain('"state":"error"');
  });
});

describe("routes/multichat studio", () => {
  // Reuses the router test harness above via a fresh in-memory app.
  const { MultichatStudioService } = require("../src/services/multichatStudio");
  let mongo2;
  let db2;
  let app2;
  let token2;

  beforeAll(async () => {
    mongo2 = await MongoMemoryServer.create();
    db2 = await connect({ uri: mongo2.getUri(), dbName: "multichat_studio_test" });
    const users2 = new UsersService(db2, {});
    const overlayTokens2 = new OverlayTokensService(db2);
    const uid = (await users2.ensureFromClerk("user_studio")).userId;
    token2 = (await overlayTokens2.create(uid, "t")).token;
    const studio = new MultichatStudioService(db2, {});
    app2 = express();
    app2.use(express.json());
    app2.use(
      "/v1",
      buildMultichatRouter({
        overlayTokens: overlayTokens2,
        users: users2,
        tiktokRelay: new TikTokChatRelay({ connectionFactory: async () => ({ on() {}, connect: async () => ({}), disconnect() {} }) }),
        studio,
        fetchImpl: async () => ({ ok: false, status: 500 }),
      }),
    );
  });

  afterAll(async () => {
    if (db2) await db2.close();
    if (mongo2) await mongo2.stop();
  });

  test("empty studio boots with defaults", async () => {
    const res = await request(app2).get(`/v1/multichat/${token2}/studio`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ highlight: null, poll: null, goals: [], blockedUsers: [], recapSeq: 0 });
  });

  test("highlight/poll/goals round-trip sanitized and persist", async () => {
    const res = await request(app2)
      .post(`/v1/multichat/${token2}/studio`)
      .send({
        highlight: { platform: "kick", user: "Fan", text: "  great game!  ", evil: 1 },
        poll: { question: "Next matchup?", options: ["PvT", "PvZ", "", "x".repeat(500)] },
        goals: [{ label: "Followers", current: -5, target: 0 }, { junk: true }],
        blockedUsers: ["@SpamBot", "spambot", "OtherGuy"],
      });
    expect(res.status).toBe(200);
    expect(res.body.highlight).toMatchObject({ platform: "kick", user: "Fan", text: "great game!" });
    expect(res.body.highlight.evil).toBeUndefined();
    expect(res.body.poll.options).toEqual(["PvT", "PvZ", "x".repeat(120)]);
    expect(res.body.poll.status).toBe("open");
    expect(res.body.goals).toEqual([{ label: "Followers", current: 0, target: 1 }]);
    expect(res.body.blockedUsers).toEqual(["spambot", "otherguy"]);
    // Persisted — a fresh GET (widget boot) sees the same state.
    const again = await request(app2).get(`/v1/multichat/${token2}/studio`);
    expect(again.body.poll.question).toBe("Next matchup?");
  });

  test("recap trigger increments a sequence; clears work", async () => {
    const r1 = await request(app2).post(`/v1/multichat/${token2}/studio`).send({ recap: true });
    const r2 = await request(app2).post(`/v1/multichat/${token2}/studio`).send({ recap: true, highlight: null, poll: null });
    expect(r2.body.recapSeq).toBe(r1.body.recapSeq + 1);
    expect(r2.body.highlight).toBeNull();
    expect(r2.body.poll).toBeNull();
  });

  test("translate without configuration is a structured 400", async () => {
    const res = await request(app2)
      .post(`/v1/multichat/${token2}/translate`)
      .send({ texts: ["hola"] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("translate_unconfigured");
  });
});

describe("sanitizeMultichatConfig", () => {
  test("empty prefs → empty config", () => {
    expect(sanitizeMultichatConfig({})).toEqual({});
    expect(sanitizeMultichatConfig(null)).toEqual({});
  });

  test("clamps oversized strings and drops bad chatroom ids", () => {
    const out = sanitizeMultichatConfig({
      twitch: { enabled: "yes", channel: "x".repeat(400) },
      kick: { enabled: true, chatroomId: -5 },
    });
    expect(out.twitch.enabled).toBe(false);
    expect(out.twitch.channel.length).toBe(120);
    expect(out.kick.chatroomId).toBeUndefined();
  });

  test("appearance passes through strict-sanitized", () => {
    const out = sanitizeMultichatConfig({
      appearance: {
        fontSize: 999,
        layout: "bubbles",
        entryAnimation: "explode",
        bgColor: "#ABCDEF",
        bgOpacity: -20,
        blockedUsers: 42,
        evil: "<script>",
      },
    });
    expect(out.appearance.fontSize).toBe(32);
    expect(out.appearance.layout).toBe("bubbles");
    expect(out.appearance.entryAnimation).toBe("fade");
    expect(out.appearance.bgColor).toBe("#abcdef");
    expect(out.appearance.bgOpacity).toBe(0);
    expect(out.appearance.blockedUsers).toBe("");
    expect(out.appearance.evil).toBeUndefined();
    // A complete render-safe object always comes back.
    expect(typeof out.appearance.maxVisible).toBe("number");
  });

  test("tts passes through strict-sanitized", () => {
    const out = sanitizeMultichatConfig({
      tts: {
        enabled: true,
        rate: 99,
        volume: 250,
        platforms: ["twitch", "myspace"],
        voiceName: 42,
        evil: true,
      },
    });
    expect(out.tts.enabled).toBe(true);
    expect(out.tts.rate).toBe(2);
    expect(out.tts.volume).toBe(100);
    expect(out.tts.platforms).toEqual(["twitch"]);
    expect(out.tts.voiceName).toBe("");
    expect(out.tts.evil).toBeUndefined();
  });

  test("sound passes through strict-sanitized", () => {
    const out = sanitizeMultichatConfig({
      sound: { enabled: true, volume: 900, evil: 1 },
    });
    expect(out.sound).toEqual({ enabled: true, volume: 100 });
  });

  test("appearance/tts/sound omitted stays omitted (no default bloat)", () => {
    const out = sanitizeMultichatConfig({ twitch: { enabled: true } });
    expect(out.appearance).toBeUndefined();
    expect(out.tts).toBeUndefined();
    expect(out.sound).toBeUndefined();
  });
});
