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
  sourceTimestampMs,
  TIKTOK_CONNECTION_OPTIONS,
  MAX_RECENT_CHAT_EVENTS,
} = require("../src/services/tiktokChatRelay");
const {
  MultichatSoundsService,
  sniffMime,
} = require("../src/services/multichatSounds");

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
    expect(out.timeoutMs).toBeGreaterThanOrEqual(5000);
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

  test("membership + paid renderers become events, not messages", () => {
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
                  liveChatPaidStickerRenderer: {
                    id: "sticker-1",
                    timestampUsec: "1768686003000000",
                    authorName: { simpleText: "StickerFan" },
                    purchaseAmountText: { simpleText: "$2.00" },
                  },
                },
              },
            },
            {
              addChatItemAction: {
                item: {
                  liveChatSponsorshipsGiftPurchaseAnnouncementRenderer: {
                    id: "gift-members-1",
                    timestampUsec: "1768686004000000",
                    header: {
                      liveChatSponsorshipsHeaderRenderer: {
                        authorName: { simpleText: "GenerousMember" },
                        primaryText: { runs: [{ text: "Gifted 5 memberships" }] },
                      },
                    },
                  },
                },
              },
            },
            {
              addChatItemAction: {
                item: {
                  liveChatSponsorshipsGiftRedemptionAnnouncementRenderer: {
                    id: "gift-received-1",
                    timestampUsec: "1768686005000000",
                    authorName: { simpleText: "LuckyViewer" },
                    message: { runs: [{ text: "received a gift membership" }] },
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
      {
        id: "sticker-1",
        kind: "superchat",
        user: "StickerFan",
        detail: "sent a Super Sticker",
        amount: "$2.00",
        atMs: 1768686003000,
      },
      {
        id: "gift-members-1",
        kind: "giftsub",
        user: "GenerousMember",
        detail: "Gifted 5 memberships",
        amount: "5 memberships",
        atMs: 1768686004000,
      },
      {
        id: "gift-received-1",
        kind: "member",
        user: "LuckyViewer",
        detail: "received a gift membership",
        atMs: 1768686005000,
      },
    ]);
    expect(out.continuation).toBe("NEXT_TOKEN_CCCCCCCCCCCCCCCCCCCC");
  });

  test("Jewels combo updates keep distinct cumulative totals", () => {
    const giftItem = (comboCount, timestampUsec) => ({
      addChatItemAction: {
        item: {
          liveChatGiftMessageRenderer: {
            id: "jewels-combo-1",
            timestampUsec,
            comboCount,
            authorName: { simpleText: "JewelFan" },
            giftName: { simpleText: "Galaxy" },
            giftAmountText: { simpleText: `${comboCount * 100} Jewels` },
          },
        },
      },
    });
    const out = yt.parseLiveChatResponse({
      continuationContents: {
        liveChatContinuation: {
          continuations: [
            {
              timedContinuationData: {
                continuation: "NEXT_TOKEN_JEWELS_COMBO_1",
                timeoutMs: 2_000,
              },
            },
          ],
          actions: [
            giftItem(1, "1768686000000000"),
            giftItem(3, "1768686001000000"),
          ],
        },
      },
    });

    expect(out.events).toEqual([
      expect.objectContaining({
        id: "jewels-combo-1:combo:1",
        updateKey: "jewels:jewels-combo-1",
        updateVersion: 1,
        kind: "gift",
        user: "JewelFan",
        detail: "sent Galaxy",
        amount: "100 Jewels",
      }),
      expect.objectContaining({
        id: "jewels-combo-1:combo:3",
        updateKey: "jewels:jewels-combo-1",
        updateVersion: 3,
        detail: "sent Galaxy x3",
        amount: "300 Jewels",
      }),
    ]);
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
    const fetchImpl = async (url) =>
      new Response(pages[url] ?? "", { status: 200 });
    const out = await yt.resolveLiveChat("@Some", { fetchImpl });
    expect(out.videoId).toBe("abcABC12345");
    expect(out.continuation).toBe("ALLCHAT_TOKEN_BBBBBBBBBBBB");
    expect(out.clientVersion).toBe("2.20260101.00.00");
  });

  test("resolveLiveChat reports not_live for an offline channel", async () => {
    const fetchImpl = async () =>
      new Response('{"videoId":"abcABC12345"}', { status: 200 });
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
      content: "hello from tiktok",
      user: { displayId: "viewer1", isModerator: true },
      common: { msgId: "m1" },
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

  test("connect startup keeps recent chat once but suppresses stale alerts", async () => {
    const conn = fakeConnection();
    conn.connect.mockImplementation(async () => {
      const startupChat = {
        content: "comment posted just before OBS attached",
        user: { displayId: "early_viewer" },
        common: { msgId: "startup-1", createTime: "1700000000123" },
      };
      conn.emit("chat", startupChat);
      // Connector 2.x may repeat the connect-response message on the
      // websocket immediately after it opens.
      conn.emit("chat", startupChat);
      conn.emit("gift", {
        giftType: 5,
        giftName: "Old gift",
        common: { msgId: "old-gift" },
      });
      conn.emit("subNotify", {
        user: { displayId: "old_subscriber" },
        common: { msgId: "old-sub" },
      });
      return { roomId: "r1" };
    });
    const relay = new TikTokChatRelay({ connectionFactory: async () => conn });
    const seen = [];
    const off = relay.subscribe("streamer", (event) => seen.push(event));

    await new Promise((r) => setImmediate(r));
    expect(seen.filter((event) => event.type === "chat")).toHaveLength(1);
    expect(seen.find((event) => event.type === "chat").message).toMatchObject({
      id: "startup-1",
      user: "early_viewer",
      text: "comment posted just before OBS attached",
      atMs: 1_700_000_000_123,
    });
    expect(seen.find((event) => event.type === "chat").replay).toBe(true);
    expect(seen.filter((event) => event.type === "event")).toHaveLength(0);

    // A notification received after connect remains live behavior.
    conn.emit("subNotify", {
      user: { displayId: "new_subscriber" },
      common: { msgId: "new-sub" },
    });
    expect(seen.find((event) => event.type === "event").event).toMatchObject({
      id: "new-sub",
      kind: "sub",
      user: "new_subscriber",
    });
    off();
  });

  test("stream end during initial data cannot resolve back to connected", async () => {
    const conn = fakeConnection();
    conn.connect.mockImplementation(async () => {
      conn.emit("chat", {
        content: "staged startup history",
        user: { displayId: "early_viewer" },
        common: { msgId: "staged-1", createTime: "1700000000123" },
      });
      conn.emit("streamEnd");
      conn.emit("chat", {
        content: "must be ignored after the end",
        user: { displayId: "late_frame" },
        common: { msgId: "staged-2", createTime: "1700000001123" },
      });
      return { roomId: "already-ended" };
    });
    const relay = new TikTokChatRelay({ connectionFactory: async () => conn });
    const seen = [];
    const off = relay.subscribe("streamer", (event) => seen.push(event));

    await new Promise((r) => setImmediate(r));
    expect(seen.at(-1)).toEqual({ type: "status", state: "ended" });
    expect(seen.some((event) => event.state === "connected")).toBe(false);
    expect(seen.some((event) => event.type === "chat")).toBe(false);
    expect(relay.channels.get("streamer").recentChatEvents).toEqual([]);
    expect(relay.channels.get("streamer").recentPlatformEvents).toEqual([]);

    off();
  });

  test("late subscribers receive recent chat and replay-marked platform events", async () => {
    const conn = fakeConnection();
    const relay = new TikTokChatRelay({ connectionFactory: async () => conn });
    const seenA = [];
    const offA = relay.subscribe("streamer", (event) => seenA.push(event));
    await new Promise((r) => setImmediate(r));

    conn.emit("gift", {
      giftType: 5,
      giftName: "Live gift",
      user: { displayId: "supporter" },
      common: { msgId: "gift-1" },
    });
    for (let i = 0; i < MAX_RECENT_CHAT_EVENTS + 2; i += 1) {
      conn.emit("chat", {
        content: `comment ${i}`,
        user: { displayId: `viewer${i}` },
        common: { msgId: `late-${i}` },
      });
    }

    const seenB = [];
    const offB = relay.subscribe("@Streamer", (event) => seenB.push(event));
    expect(seenB[0]).toMatchObject({ type: "status", state: "connected" });
    expect(seenB.filter((event) => event.type === "event")).toEqual([
      expect.objectContaining({
        type: "event",
        replay: true,
        session: "r1",
        event: expect.objectContaining({
          id: "gift-1",
          kind: "gift",
          user: "supporter",
        }),
      }),
    ]);
    const replayed = seenB.filter((event) => event.type === "chat");
    expect(replayed).toHaveLength(MAX_RECENT_CHAT_EVENTS);
    expect(replayed.every((event) => event.replay === true)).toBe(true);
    expect(replayed[0].message).toMatchObject({
      id: "late-2",
      text: "comment 2",
    });
    expect(replayed.at(-1).message).toMatchObject({
      id: `late-${MAX_RECENT_CHAT_EVENTS + 1}`,
      text: `comment ${MAX_RECENT_CHAT_EVENTS + 1}`,
    });

    conn.emit("streamEnd");
    const seenAfterEnd = [];
    const offAfterEnd = relay.subscribe("streamer", (event) =>
      seenAfterEnd.push(event),
    );
    expect(seenAfterEnd).toEqual([{ type: "status", state: "ended" }]);

    offAfterEnd();
    offB();
    offA();
  });

  test("a surface joining mid-reconnect receives same-room history once", async () => {
    const first = fakeConnection();
    const reconnect = fakeConnection();
    const repeated = {
      content: "message before the connection blip",
      user: { displayId: "viewer1" },
      common: { msgId: "same-room-1", createTime: "1700000000000" },
    };
    reconnect.connect.mockImplementation(async () => {
      reconnect.emit("chat", repeated);
      return { roomId: "r1" };
    });
    const connectionFactory = jest
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(reconnect);
    const relay = new TikTokChatRelay({ connectionFactory });
    const seenA = [];
    const offA = relay.subscribe("streamer", (event) => seenA.push(event));
    await new Promise((r) => setImmediate(r));
    const channel = relay.channels.get("streamer");
    channel.scheduleRetry = jest.fn();

    first.emit("chat", repeated);
    first.emit("disconnected");
    const seenB = [];
    const offB = relay.subscribe("streamer", (event) => seenB.push(event));
    expect(seenB).toEqual([{ type: "status", state: "connecting" }]);

    await channel.connectOnce();
    const chatsA = seenA.filter((event) => event.type === "chat");
    const chatsB = seenB.filter((event) => event.type === "chat");
    expect(chatsA).toHaveLength(1);
    expect(chatsB).toEqual([
      expect.objectContaining({
        replay: true,
        session: "r1",
        message: expect.objectContaining({ id: "same-room-1" }),
      }),
    ]);
    expect(seenB).toContainEqual({ type: "status", state: "connected" });

    offB();
    offA();
  });

  test("a changed TikTok room starts a fresh retained-chat session", async () => {
    const first = fakeConnection();
    const next = fakeConnection();
    next.connect.mockImplementation(async () => {
      next.emit("chat", {
        content: "new broadcast, reused connector id",
        user: { displayId: "new_viewer" },
        common: { msgId: "room-local-1", createTime: "1700000060000" },
      });
      return { roomId: "r2" };
    });
    const connectionFactory = jest
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(next);
    const relay = new TikTokChatRelay({ connectionFactory });
    const seenA = [];
    const offA = relay.subscribe("streamer", (event) => seenA.push(event));
    await new Promise((r) => setImmediate(r));
    const channel = relay.channels.get("streamer");
    channel.scheduleRetry = jest.fn();

    first.emit("chat", {
      content: "prior broadcast",
      user: { displayId: "old_viewer" },
      common: { msgId: "room-local-1", createTime: "1700000000000" },
    });
    first.emit("disconnected");
    const seenB = [];
    const offB = relay.subscribe("streamer", (event) => seenB.push(event));

    await channel.connectOnce();
    const chatsB = seenB.filter((event) => event.type === "chat");
    expect(chatsB).toHaveLength(1);
    expect(chatsB[0]).toMatchObject({
      replay: true,
      session: "r2",
      message: {
        id: "room-local-1",
        text: "new broadcast, reused connector id",
      },
    });
    const seenLate = [];
    const offLate = relay.subscribe("streamer", (event) =>
      seenLate.push(event),
    );
    expect(seenLate.filter((event) => event.type === "chat")).toEqual([
      expect.objectContaining({
        replay: true,
        message: expect.objectContaining({
          text: "new broadcast, reused connector id",
        }),
      }),
    ]);

    offLate();
    offB();
    offA();
  });

  test("production connector requests TikTok's initial comment batch", () => {
    expect(TIKTOK_CONNECTION_OPTIONS).toEqual({
      processInitialData: true,
      enableExtendedGiftInfo: true,
    });
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

  test("an offline boundary drops the prior live before the next broadcast", async () => {
    const live = fakeConnection();
    const offline = fakeConnection();
    offline.connect.mockRejectedValue(
      new Error("The requested user isn't online :("),
    );
    const nextLive = fakeConnection();
    nextLive.connect.mockImplementation(async () => {
      nextLive.emit("chat", {
        content: "first comment in the next live",
        user: { displayId: "new_viewer" },
        common: { msgId: "new-1", createTime: "1700000060000" },
      });
      return { roomId: "r2" };
    });
    const connectionFactory = jest
      .fn()
      .mockResolvedValueOnce(live)
      .mockResolvedValueOnce(offline)
      .mockResolvedValueOnce(nextLive);
    const relay = new TikTokChatRelay({ connectionFactory });
    const firstSurface = [];
    const offFirst = relay.subscribe("streamer", (event) =>
      firstSurface.push(event),
    );
    await new Promise((r) => setImmediate(r));
    const channel = relay.channels.get("streamer");
    // Drive retries synchronously; timer scheduling itself is covered
    // by the existing offline/disconnect tests.
    channel.scheduleRetry = jest.fn();

    live.emit("chat", {
      content: "comment from the prior live",
      user: { displayId: "old_viewer" },
      common: { msgId: "old-1", createTime: "1700000000000" },
    });
    live.emit("disconnected");
    await channel.connectOnce();
    expect(channel.state).toBe("offline");
    expect(channel.recentChatEvents).toEqual([]);
    expect(channel.recentPlatformEvents).toEqual([]);
    expect(channel.seenChatIds.size).toBe(0);

    const whileOffline = [];
    const offWhileOffline = relay.subscribe("streamer", (event) =>
      whileOffline.push(event),
    );
    expect(whileOffline).toEqual([{ type: "status", state: "offline" }]);

    await channel.connectOnce();
    const nextSurface = [];
    const offNext = relay.subscribe("streamer", (event) =>
      nextSurface.push(event),
    );
    expect(nextSurface[0]).toEqual({ type: "status", state: "connected" });
    expect(nextSurface.filter((event) => event.type === "chat")).toEqual([
      expect.objectContaining({
        replay: true,
        message: expect.objectContaining({
          id: "new-1",
          text: "first comment in the next live",
        }),
      }),
    ]);
    expect(nextSurface.some((event) => event.message?.id === "old-1")).toBe(
      false,
    );

    offNext();
    offWhileOffline();
    offFirst();
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

  test("mapChatEvent accepts current and legacy connector fields", () => {
    expect(
      mapChatEvent({
        comment: "   ",
        content: "current payload",
        user: { displayId: "current_user" },
        common: { msgId: "current-1", createTime: "1700000000123" },
      }),
    ).toMatchObject({
      id: "current-1",
      user: "current_user",
      text: "current payload",
      atMs: 1_700_000_000_123,
    });
    expect(
      mapChatEvent({
        comment: "legacy payload",
        user: { uniqueId: "legacy_user" },
        msgId: "legacy-1",
      }),
    ).toMatchObject({
      id: "legacy-1",
      user: "legacy_user",
      text: "legacy payload",
    });
    expect(sourceTimestampMs({ createTime: "1700000000" })).toBe(
      1_700_000_000_000,
    );
  });

  test("mapChatEvent drops empty chat and caps length", () => {
    expect(mapChatEvent({ content: "   " })).toBeNull();
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
      amount: "3 gifts",
      atMs: expect.any(Number),
    });
    // Non-streak gift emits immediately; absent fields still emit.
    expect(
      mapTikTokEvent("gift", {
        giftDetails: { giftType: 5, giftName: "Galaxy" },
        extendedGiftInfo: { diamond_count: 1000 },
        repeatCount: 2,
        uniqueId: "fan2",
      }),
    ).toMatchObject({
      kind: "gift",
      user: "fan2",
      detail: "sent Galaxy x2",
      amount: "2,000 diamonds",
    });
    expect(mapTikTokEvent("gift", {})).toMatchObject({
      kind: "gift",
      user: "viewer",
      detail: "sent a gift",
    });
  });

  test("mapTikTokEvent maps follow/subscribe/share and drops unknown names", () => {
    expect(
      mapTikTokEvent("follow", { user: { uniqueId: "newfan" } }),
    ).toMatchObject({ kind: "follow", user: "newfan", detail: "followed" });
    expect(
      mapTikTokEvent("follow", { user: { displayId: "currentfan" } }),
    ).toMatchObject({ kind: "follow", user: "currentfan", detail: "followed" });
    expect(
      mapTikTokEvent("subscribe", { uniqueId: "supporter" }),
    ).toMatchObject({ kind: "sub", user: "supporter", detail: "subscribed" });
    expect(
      mapTikTokEvent("subscribe", { uniqueId: "loyal", subMonth: 7 }),
    ).toMatchObject({
      kind: "resub",
      user: "loyal",
      detail: "subscribed for 7 months",
      amount: "7 months",
    });
    expect(
      mapTikTokEvent("share", { uniqueId: "amplifier", msgId: "share-1" }),
    ).toMatchObject({
      id: "share-1",
      kind: "share",
      user: "amplifier",
      detail: "shared the stream",
    });
    expect(mapTikTokEvent("like", { uniqueId: "x" })).toBeNull();
  });

  test("gift/follow/share events fan out once over the relay", async () => {
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
    conn.emit("share", { user: { uniqueId: "sharer" }, msgId: "s1" });
    conn.emit("share", { user: { uniqueId: "sharer" }, msgId: "s1" });
    const events = seen.filter((e) => e.type === "event").map((e) => e.event);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ kind: "gift", id: "g2", user: "fan" });
    expect(events[1]).toMatchObject({ kind: "follow", user: "newfan" });
    expect(events[2]).toMatchObject({ kind: "share", id: "s1", user: "sharer" });
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

  test("ticker-facts serves the per-user pool; absent service → empty", async () => {
    // The boot app above has no tickerFacts dep — route degrades to [].
    const empty = await request(app).get(`/v1/multichat/${token}/ticker-facts`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ facts: [] });
    // With the dep wired, the resolved token's userId reaches the service.
    const seen = [];
    const app2 = express();
    app2.use(express.json());
    app2.use(
      "/v1",
      buildMultichatRouter({
        overlayTokens,
        users,
        tiktokRelay: relay,
        tickerFacts: {
          factsFor: async (uid) => {
            seen.push(uid);
            return [{ id: "career-record", text: "CAREER: 10 W – 5 L" }];
          },
        },
      }),
    );
    const res = await request(app2).get(`/v1/multichat/${token}/ticker-facts`);
    expect(res.status).toBe(200);
    expect(res.body.facts).toHaveLength(1);
    expect(seen).toEqual([userId]);
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

const EMPTY_BROLL = {
  clips: [],
  shuffle: true,
  muted: false,
  volume: 20,
  skipNonce: 0,
  playback: { epochMs: 0, revision: 0, seed: 0, cursor: 0 },
};
const OWNER_A_CLIP = {
  id: "owner-a-clip",
  title: "Owner A private highlight",
  videoId: "AbCdEf12345",
  startSeconds: 15,
  endSeconds: 55,
};
const OWNER_B_CLIP = {
  id: "owner-b-clip",
  title: "Owner B private highlight",
  videoId: "ZyXwVu98765",
  startSeconds: 70,
  endSeconds: 120,
};

describe("routes/multichat studio", () => {
  // Reuses the router test harness above via a fresh in-memory app.
  const { MultichatStudioService } = require("../src/services/multichatStudio");
  let mongo2;
  let db2;
  let app2;
  let token2;
  let sameOwnerToken2;
  let otherOwnerToken2;
  let uid2;
  let overlayTokens2;
  let sounds2;

  beforeAll(async () => {
    mongo2 = await MongoMemoryServer.create();
    db2 = await connect({ uri: mongo2.getUri(), dbName: "multichat_studio_test" });
    const users2 = new UsersService(db2, {});
    overlayTokens2 = new OverlayTokensService(db2);
    const uid = (await users2.ensureFromClerk("user_studio")).userId;
    uid2 = uid;
    token2 = (await overlayTokens2.create(uid, "t")).token;
    sameOwnerToken2 = (await overlayTokens2.create(uid, "same-owner-second-token")).token;
    const otherUid = (await users2.ensureFromClerk("user_studio_other")).userId;
    otherOwnerToken2 = (await overlayTokens2.create(otherUid, "other-owner-token")).token;
    const studio = new MultichatStudioService(db2, {});
    sounds2 = new MultichatSoundsService(db2);
    app2 = express();
    app2.use(express.json());
    app2.use(
      "/v1",
      buildMultichatRouter({
        overlayTokens: overlayTokens2,
        users: users2,
        tiktokRelay: new TikTokChatRelay({ connectionFactory: async () => ({ on() {}, connect: async () => ({}), disconnect() {} }) }),
        studio,
        sounds: sounds2,
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
    expect(res.body).toMatchObject({
      highlight: null,
      poll: null,
      goals: [],
      blockedUsers: [],
      recapSeq: 0,
      broll: {
        clips: [],
        shuffle: true,
        muted: false,
        volume: 20,
        skipNonce: 0,
      },
    });
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

  test("deleting goals persists the shrunk list, down to empty", async () => {
    // Regression for the Stream Dock delete flow: a POST with fewer
    // (or zero) goals must replace the stored list wholesale — the
    // overlay renders exactly what comes back, so a kept-around stale
    // goal here is a goal stuck on stream.
    await request(app2)
      .post(`/v1/multichat/${token2}/studio`)
      .send({ goals: [
        { label: "Followers", current: 5, target: 10 },
        { label: "Subs", current: 1, target: 5 },
      ] });
    const shrunk = await request(app2)
      .post(`/v1/multichat/${token2}/studio`)
      .send({ goals: [{ label: "Followers", current: 5, target: 10 }] });
    expect(shrunk.body.goals).toEqual([
      { label: "Followers", current: 5, target: 10 },
    ]);
    const emptied = await request(app2)
      .post(`/v1/multichat/${token2}/studio`)
      .send({ goals: [] });
    expect(emptied.body.goals).toEqual([]);
    // Persisted — the widget's fallback refetch sees the deletion too.
    const again = await request(app2).get(`/v1/multichat/${token2}/studio`);
    expect(again.body.goals).toEqual([]);
  });

  test("timer round-trips; past/junk clears", async () => {
    const future = Date.now() + 5 * 60_000;
    const set = await request(app2)
      .post(`/v1/multichat/${token2}/studio`)
      .send({ timer: { label: "x".repeat(100), endsAt: future, evil: 1 } });
    expect(set.body.timer.endsAt).toBe(future);
    expect(set.body.timer.label.length).toBe(40);
    expect(set.body.timer.evil).toBeUndefined();
    const past = await request(app2)
      .post(`/v1/multichat/${token2}/studio`)
      .send({ timer: { endsAt: 1000 } });
    expect(past.body.timer).toBeNull();
    const cleared = await request(app2)
      .post(`/v1/multichat/${token2}/studio`)
      .send({ timer: null });
    expect(cleared.body.timer).toBeNull();
  });

  test("b-roll playlist and player controls round-trip sanitized", async () => {
    const set = await request(app2)
      .post(`/v1/multichat/${token2}/studio`)
      .send({
        broll: {
          clips: [
            {
              id: "  comeback-1  ",
              title: "  Huge comeback  ",
              videoId: "AbCdEf12345",
              startSeconds: 90.9,
              endSeconds: 141.2,
              unsafeUrl: "javascript:alert(1)",
            },
            {
              id: "bad-video",
              title: "Rejected",
              videoId: "https://youtube.com/watch?v=AbCdEf12345",
              startSeconds: 0,
              endSeconds: 10,
            },
          ],
          shuffle: false,
          muted: true,
          volume: 120,
          skipNonce: 7.9,
          evil: true,
        },
      });
    expect(set.status).toBe(200);
    expect(set.body.broll).toEqual({
      clips: [
        {
          id: "comeback-1",
          title: "Huge comeback",
          videoId: "AbCdEf12345",
          startSeconds: 90,
          endSeconds: 141,
        },
      ],
      shuffle: false,
      muted: true,
      volume: 100,
      skipNonce: 7,
      playback: {
        epochMs: expect.any(Number),
        revision: 1,
        seed: expect.any(Number),
        cursor: 0,
      },
    });
    const again = await request(app2).get(
      `/v1/multichat/${token2}/studio`,
    );
    expect(again.body.broll).toEqual(set.body.broll);

    // null is an explicit reset, useful when removing the playlist.
    const reset = await request(app2)
      .post(`/v1/multichat/${token2}/studio`)
      .send({ broll: null });
    expect(reset.body.broll).toEqual({
      clips: [],
      shuffle: true,
      muted: false,
      volume: 20,
      skipNonce: 0,
      playback: { epochMs: 0, revision: 2, seed: 0, cursor: 0 },
    });
  });

  test("b-roll stays isolated by exact token across same and different owners", async () => {
    const setOwner = await request(app2)
      .post(`/v1/multichat/${token2}/studio`)
      .send({ broll: { clips: [OWNER_A_CLIP] } });
    expect(setOwner.status).toBe(200);
    expect(setOwner.body.broll.clips).toEqual([OWNER_A_CLIP]);

    // Studio state is token-scoped even when both tokens belong to the same
    // account. A second OBS/dock setup starts with an independent empty reel.
    const sameOwnerEmpty = await request(app2).get(
      `/v1/multichat/${sameOwnerToken2}/studio`,
    );
    expect(sameOwnerEmpty.status).toBe(200);
    expect(sameOwnerEmpty.body.broll).toEqual(EMPTY_BROLL);

    // A different owner's valid token is independent in both directions.
    const otherOwnerEmpty = await request(app2).get(
      `/v1/multichat/${otherOwnerToken2}/studio`,
    );
    expect(otherOwnerEmpty.status).toBe(200);
    expect(otherOwnerEmpty.body.broll).toEqual(EMPTY_BROLL);
    const setOther = await request(app2)
      .post(`/v1/multichat/${otherOwnerToken2}/studio`)
      .send({ broll: { clips: [OWNER_B_CLIP], shuffle: false } });
    expect(setOther.status).toBe(200);
    expect(setOther.body.broll.clips).toEqual([OWNER_B_CLIP]);

    const ownerAgain = await request(app2).get(
      `/v1/multichat/${token2}/studio`,
    );
    expect(ownerAgain.body.broll.clips).toEqual([OWNER_A_CLIP]);
    expect(ownerAgain.body.broll.clips).not.toContainEqual(OWNER_B_CLIP);
  });

  test("unknown and revoked tokens cannot read or write Studio state", async () => {
    // Unknown and revoked bearer tokens fail before Studio persistence is
    // touched, even if they attempt to POST a syntactically valid library.
    const unknownToken = "unknown-overlay-token";
    const unknown = await request(app2)
      .post(`/v1/multichat/${unknownToken}/studio`)
      .send({ broll: { clips: [OWNER_B_CLIP] } });
    expect(unknown.status).toBe(401);
    expect(
      await db2.multichatStudio.countDocuments({ token: unknownToken }),
    ).toBe(0);

    await overlayTokens2.revoke(uid2, sameOwnerToken2);
    const revoked = await request(app2).get(
      `/v1/multichat/${sameOwnerToken2}/studio`,
    );
    expect(revoked.status).toBe(401);
  });

  test("stream-start mark round-trips; garbage epochs clear", async () => {
    const now = Date.now();
    const set = await request(app2)
      .post(`/v1/multichat/${token2}/studio`)
      .send({ streamStartMs: now });
    expect(set.body.streamStartMs).toBe(now);
    // Ancient / far-future epochs would produce nonsense VOD offsets.
    const junk = await request(app2)
      .post(`/v1/multichat/${token2}/studio`)
      .send({ streamStartMs: 12345 });
    expect(junk.body.streamStartMs).toBeNull();
    const cleared = await request(app2)
      .post(`/v1/multichat/${token2}/studio`)
      .send({ streamStartMs: null });
    expect(cleared.body.streamStartMs).toBeNull();
  });

  test("vod url keeps https only — nothing script-shaped survives", async () => {
    const ok = await request(app2)
      .post(`/v1/multichat/${token2}/studio`)
      .send({ vodUrl: "https://www.twitch.tv/videos/123456789" });
    expect(ok.body.vodUrl).toBe("https://www.twitch.tv/videos/123456789");
    for (const bad of [
      "javascript:alert(1)",
      "http://insecure.example/vod",
      "not a url",
      "x".repeat(400),
    ]) {
      const res = await request(app2)
        .post(`/v1/multichat/${token2}/studio`)
        .send({ vodUrl: bad });
      expect(res.body.vodUrl).toBeNull();
    }
  });

  test("recap trigger increments a sequence; clears work", async () => {
    const r1 = await request(app2).post(`/v1/multichat/${token2}/studio`).send({ recap: true });
    const r2 = await request(app2).post(`/v1/multichat/${token2}/studio`).send({ recap: true, highlight: null, poll: null });
    expect(r2.body.recapSeq).toBe(r1.body.recapSeq + 1);
    expect(r2.body.highlight).toBeNull();
    expect(r2.body.poll).toBeNull();
  });

  test("scene round-trips sanitized; Go live clears it", async () => {
    const future = Date.now() + 5 * 60_000;
    const set = await request(app2)
      .post(`/v1/multichat/${token2}/studio`)
      .send({
        scene: {
          mode: "starting",
          message: "x".repeat(200),
          countdownEndsAt: future,
          evil: true,
        },
      });
    expect(set.status).toBe(200);
    expect(set.body.scene.mode).toBe("starting");
    expect(set.body.scene.message.length).toBe(80);
    expect(set.body.scene.countdownEndsAt).toBe(future);
    expect(set.body.scene.evil).toBeUndefined();
    // A countdown in the past sanitizes to no countdown.
    const stale = await request(app2)
      .post(`/v1/multichat/${token2}/studio`)
      .send({ scene: { mode: "brb", countdownEndsAt: 1000 } });
    expect(stale.body.scene.mode).toBe("brb");
    expect(stale.body.scene.countdownEndsAt).toBeNull();
    // Junk mode = go live.
    const live = await request(app2)
      .post(`/v1/multichat/${token2}/studio`)
      .send({ scene: { mode: "party" } });
    expect(live.body.scene).toBeNull();
    const cleared = await request(app2)
      .post(`/v1/multichat/${token2}/studio`)
      .send({ scene: null });
    expect(cleared.body.scene).toBeNull();
  });

  test("uploaded sounds: caps, magic bytes, list/serve/delete", async () => {
    // Not audio → rejected.
    await expect(
      sounds2.create(uid2, "junk", Buffer.from("not audio at all")),
    ).rejects.toMatchObject({ code: "bad_format" });
    // A minimal MP3 (ID3 header) passes the sniff.
    const mp3 = Buffer.concat([
      Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]),
      Buffer.alloc(64, 1),
    ]);
    expect(sniffMime(mp3)).toBe("audio/mpeg");
    const created = await sounds2.create(uid2, "  My clip  ", mp3);
    expect(created.label).toBe("My clip");
    expect(created.mime).toBe("audio/mpeg");
    const listed = await sounds2.list(uid2);
    expect(listed.map((s) => s.soundId)).toContain(created.soundId);
    expect(listed[0].data).toBeUndefined();
    // Token route serves the bytes with the sniffed content type.
    const served = await request(app2).get(
      `/v1/multichat/${token2}/sound/${created.soundId}`,
    );
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(served.body.length).toBe(mp3.length);
    // Unknown id → 404.
    const missing = await request(app2).get(
      `/v1/multichat/${token2}/sound/ffffffff-0000`,
    );
    expect(missing.status).toBe(404);
    // Size cap.
    await expect(
      sounds2.create(uid2, "big", Buffer.concat([mp3, Buffer.alloc(400 * 1024)])),
    ).rejects.toMatchObject({ code: "too_large" });
    // Delete → gone.
    expect(await sounds2.remove(uid2, created.soundId)).toBe(true);
    expect(
      (await request(app2).get(`/v1/multichat/${token2}/sound/${created.soundId}`))
        .status,
    ).toBe(404);
  });

  test("config route rewrites upload entries to token-served URLs", async () => {
    const mp3 = Buffer.concat([
      Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]),
      Buffer.alloc(64, 1),
    ]);
    const created = await sounds2.create(uid2, "Boom", mp3);
    const users2b = new UsersService(db2, {});
    await users2b.updatePreferences(uid2, "multichat", {
      sound: {
        enabled: true,
        customSounds: [
          { id: "c-boom", label: "Boom", kind: "upload", uploadId: created.soundId },
          { id: "c-link", label: "Link", kind: "url", url: "https://x.example/a.mp3" },
        ],
      },
    });
    const res = await request(app2).get(`/v1/multichat/${token2}/config`);
    expect(res.status).toBe(200);
    const customs = res.body.config.sound.customSounds;
    expect(customs).toHaveLength(2);
    expect(customs[0]).toEqual({
      id: "c-boom",
      label: "Boom",
      kind: "upload",
      url: `/v1/multichat/${token2}/sound/${created.soundId}`,
    });
    expect(customs[1].url).toBe("https://x.example/a.mp3");
    await sounds2.remove(uid2, created.soundId);
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
    expect(out.appearance.messageTtlSec).toBe(30);

    const explicitNever = sanitizeMultichatConfig({
      appearance: { messageTtlSec: 0 },
    });
    expect(explicitNever.appearance.messageTtlSec).toBe(0);
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
    // New effect fields materialize with defaults; unknown keys drop.
    expect(out.sound).toEqual({
      enabled: true,
      volume: 100,
      messageSound: "ding",
      eventSoundsEnabled: false,
      eventVolume: 70,
      eventSounds: {
        sub: "victory",
        resub: "victory",
        giftsub: "airhorn",
        raid: "airhorn",
        member: "sparkle",
        superchat: "coin",
        gift: "coin",
        follow: "pop",
        cheer: "coin",
        share: "pop",
        reward: "sparkle",
      },
      customSounds: [],
    });
  });

  test("pack ids and custom sounds pass the unified whitelist", () => {
    const out = sanitizeMultichatConfig({
      sound: {
        messageSound: "metal-pipe",
        eventSounds: { raid: "real-airhorn", sub: "c-mine", gift: "c-ghost" },
        customSounds: [
          { id: "c-mine", label: "Mine", kind: "url", url: "https://x.example/a.mp3" },
          { id: "c-up", label: "Up", kind: "upload", uploadId: "abcdef12-3456" },
          { id: "c-say", label: "Say", kind: "tts", text: "hello chat", rate: 0.1 },
          { id: "nope", label: "bad id", kind: "url", url: "https://x/a.mp3" },
          { id: "c-http", label: "insecure", kind: "url", url: "http://x/a.mp3" },
        ],
      },
    });
    expect(out.sound.messageSound).toBe("metal-pipe");
    expect(out.sound.eventSounds.raid).toBe("real-airhorn");
    expect(out.sound.eventSounds.sub).toBe("c-mine");
    // Reference to a custom id that doesn't survive sanitize → default.
    expect(out.sound.eventSounds.gift).toBe("coin");
    expect(out.sound.customSounds.map((c) => c.id)).toEqual(["c-mine", "c-up", "c-say"]);
    expect(out.sound.customSounds[2].rate).toBe(0.5);
  });

  test("sound effect picks round-trip; junk ids fall back per-kind", () => {
    const out = sanitizeMultichatConfig({
      sound: {
        enabled: true,
        messageSound: "coin",
        eventSoundsEnabled: true,
        eventVolume: -5,
        eventSounds: { raid: "bass-drop", sub: "none", follow: "vuvuzela" },
      },
    });
    expect(out.sound.messageSound).toBe("coin");
    expect(out.sound.eventSoundsEnabled).toBe(true);
    expect(out.sound.eventVolume).toBe(0);
    expect(out.sound.eventSounds.raid).toBe("bass-drop");
    expect(out.sound.eventSounds.sub).toBe("none");
    // Unknown effect id → that kind's default, not silence.
    expect(out.sound.eventSounds.follow).toBe("pop");
    expect(out.sound.messageSound).not.toBe("vuvuzela");
  });

  test("appearance/tts/sound omitted stays omitted (no default bloat)", () => {
    const out = sanitizeMultichatConfig({ twitch: { enabled: true } });
    expect(out.appearance).toBeUndefined();
    expect(out.tts).toBeUndefined();
    expect(out.sound).toBeUndefined();
  });

  test("engagement rank race passes through whitelisted", () => {
    expect(
      sanitizeMultichatConfig({ engagement: { rankRace: "terran" } }).engagement,
    ).toEqual({ rankRace: "terran" });
    expect(
      sanitizeMultichatConfig({ engagement: { rankRace: "xelnaga" } }).engagement,
    ).toEqual({ rankRace: "protoss" });
    expect(sanitizeMultichatConfig({}).engagement).toBeUndefined();
  });

  test("translate local mode enables without an endpoint", () => {
    const out = sanitizeMultichatConfig({
      translate: { enabled: true, mode: "local" },
    });
    expect(out.translate).toEqual({
      enabled: true,
      mode: "local",
      targetLang: "en",
    });
  });

  test("translate provider mode without an https endpoint stays disabled", () => {
    const out = sanitizeMultichatConfig({
      translate: { enabled: true, mode: "provider", endpoint: "http://insecure" },
    });
    expect(out.translate).toEqual({
      enabled: false,
      mode: "provider",
      targetLang: "en",
    });
  });

  test("translate provider mode with an https endpoint enables — secrets never exposed", () => {
    const out = sanitizeMultichatConfig({
      translate: {
        enabled: true,
        mode: "provider",
        endpoint: "https://libre.example/translate",
        apiKey: "sekrit",
        targetLang: "de",
      },
    });
    expect(out.translate).toEqual({
      enabled: true,
      mode: "provider",
      targetLang: "de",
    });
    expect(out.translate.endpoint).toBeUndefined();
    expect(out.translate.apiKey).toBeUndefined();
  });

  test("translate mode defaults to local for legacy blobs without mode", () => {
    const out = sanitizeMultichatConfig({
      translate: { enabled: true, endpoint: "https://libre.example/translate" },
    });
    expect(out.translate).toEqual({
      enabled: true,
      mode: "local",
      targetLang: "en",
    });
  });
});
