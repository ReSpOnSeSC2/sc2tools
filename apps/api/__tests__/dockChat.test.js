// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { registerDockChatRoutes } = require("../src/routes/dockChat");

function setup() {
  const app = express(); app.use(express.json());
  const config = { twitch: { enabled: true, channel: "streamer" }, kick: { enabled: true, channel: "streamer", chatroomId: 5 },
    youtube: { enabled: true, channel: "@streamer" }, tiktok: { enabled: true, username: "streamer" } };
  const deps = {
    tokenAuth: (req, res, next) => req.params.token === "valid" ? (req.overlayUserId = "owner", next()) : res.status(401).json({ error: { code: "invalid_overlay_token" } }),
    limiter: (_req, _res, next) => next(),
    users: { getPreferences: jest.fn(async () => config) },
    overlayTokens: { resolve: jest.fn(async () => ({ userId: "owner" })), withWrite: jest.fn(async (_token, work) => work()) },
    platformChat: { status: jest.fn(async () => [
      { platform: "twitch", available: false, reason: "Connect chat permissions.", maxLength: 500 },
      { platform: "kick", available: true, identity: "streamer", maxLength: 500 },
      { platform: "youtube", available: true, identity: "streamer", maxLength: 200 },
      { platform: "tiktok", available: false, reason: "Reply in TikTok.", maxLength: 200 },
    ]), send: jest.fn(async (_owner, platform) => {
      if (platform === "tiktok") throw Object.assign(new Error("Reply in TikTok."), { name: "PlatformChatError" });
      return { status: "sent" };
    }) },
    twitchChatBot: { chatStatus: jest.fn(() => ({ platform: "twitch", available: true, identity: "streambot", maxLength: 450 })),
      queueChat: jest.fn(() => ({ status: "queued", message: "Queued as streambot on Twitch." })) },
  };
  const router = express.Router(); registerDockChatRoutes(router, deps); app.use("/v1", router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: { code: err.code || "internal_error" } }));
  return { app, deps, config };
}

describe("Dock chat sending", () => {
  test("reports the configured bot identity and separate unavailable platforms", async () => {
    const { app } = setup(); const res = await request(app).get("/v1/multichat/valid/chat").expect(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body.platforms[0]).toMatchObject({ available: true, identity: "streambot", maxLength: 450 });
    expect(res.body.platforms[3]).toMatchObject({ available: false, reason: "Reply in TikTok." });
  });
  test("sends only selected destinations and reports partial results without retries", async () => {
    const { app, deps } = setup();
    const res = await request(app).post("/v1/multichat/valid/chat").send({ text: " Hello chat! ", platforms: ["twitch", "youtube", "tiktok"] }).expect(200);
    expect(res.body.results.map(row => [row.platform, row.status])).toEqual([["twitch", "queued"], ["youtube", "sent"], ["tiktok", "failed"]]);
    expect(deps.twitchChatBot.queueChat).toHaveBeenCalledWith("owner", "valid", "streamer", " Hello chat! ");
    expect(deps.platformChat.send).toHaveBeenCalledTimes(2);
    expect(deps.platformChat.send).toHaveBeenCalledWith("owner", "youtube", "Hello chat!", expect.any(Object));
    expect(deps.platformChat.send.mock.calls.map(args => args[1])).not.toContain("kick");
    expect(deps.overlayTokens.withWrite).toHaveBeenCalledTimes(1);
  });
  test.each([
    { text: "", platforms: ["twitch"] }, { text: "hi\r\nPRIVMSG #other :oops", platforms: ["twitch"] },
    { text: "hi", platforms: [] }, { text: "hi", platforms: ["twitch", "twitch"] },
    { text: "hi", platforms: ["unknown"] }, { text: "hi", platforms: ["kick"], channel: "other" },
    { text: "x".repeat(501), platforms: ["kick"] },
  ])("rejects invalid messages without provider writes (%j)", async body => {
    const { app, deps } = setup(); await request(app).post("/v1/multichat/valid/chat").send(body).expect(400);
    expect(deps.platformChat.send).not.toHaveBeenCalled(); expect(deps.twitchChatBot.queueChat).not.toHaveBeenCalled();
  });
  test("refuses disabled destinations and ignores a bot in an unconfigured channel", async () => {
    const { app, deps, config } = setup(); config.twitch.enabled = false; config.kick.enabled = false;
    const status = await request(app).get("/v1/multichat/valid/chat").expect(200);
    expect(status.body.platforms[0].available).toBe(false);
    const res = await request(app).post("/v1/multichat/valid/chat").send({ text: "hi", platforms: ["twitch", "kick"] }).expect(200);
    expect(res.body.results.every(row => row.status === "failed")).toBe(true);
    expect(deps.platformChat.send).not.toHaveBeenCalled(); expect(deps.twitchChatBot.queueChat).not.toHaveBeenCalled();
  });
  test("uses provider chat if the bot is unavailable and hides unknown errors", async () => {
    const { app, deps } = setup(); deps.twitchChatBot.chatStatus.mockReturnValue({ available: false });
    deps.platformChat.send.mockRejectedValue(new Error("provider secret token"));
    const res = await request(app).post("/v1/multichat/valid/chat").send({ text: "hi", platforms: ["twitch"] }).expect(200);
    expect(res.body.results[0]).toMatchObject({ platform: "twitch", status: "unknown", message: expect.stringContaining("Check this platform's chat") });
    expect(JSON.stringify(res.body)).not.toContain("secret"); expect(deps.twitchChatBot.queueChat).not.toHaveBeenCalled();
  });
  test("preserves ambiguous provider acknowledgements so a retry cannot duplicate a send", async () => {
    const { app, deps } = setup();
    deps.platformChat.send.mockRejectedValue(Object.assign(new Error("Delivery unconfirmed. Check YouTube chat."), { name: "PlatformChatError", deliveryUnknown: true }));
    const res = await request(app).post("/v1/multichat/valid/chat").send({ text: "hi", platforms: ["youtube"] }).expect(200);
    expect(res.body.results[0]).toEqual({ platform: "youtube", status: "unknown", message: "Delivery unconfirmed. Check YouTube chat." });
    expect(deps.platformChat.send).toHaveBeenCalledTimes(1);
  });
  test("rejects invalid and changed credentials before sending", async () => {
    const { app, deps } = setup();
    await request(app).post("/v1/multichat/invalid/chat").send({ text: "hi", platforms: ["kick"] }).expect(401);
    deps.overlayTokens.resolve.mockResolvedValue({ userId: "another-owner" });
    await request(app).post("/v1/multichat/valid/chat").send({ text: "hi", platforms: ["kick"] }).expect(401);
    expect(deps.platformChat.send).not.toHaveBeenCalled();
  });
  test("bounds message sends separately from status reads", async () => {
    const { app, deps } = setup();
    for (let i = 0; i < 6; i++) await request(app).post("/v1/multichat/valid/chat").send({ text: `hi ${i}`, platforms: ["kick"] }).expect(200);
    const blocked = await request(app).post("/v1/multichat/valid/chat").send({ text: "seventh", platforms: ["kick"] }).expect(429);
    expect(blocked.body.error.code).toBe("chat_rate_limited"); expect(deps.platformChat.send).toHaveBeenCalledTimes(6);
    await request(app).get("/v1/multichat/valid/chat").expect(200);
  });
});
