// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { buildChatCommandsOwnerRouter } = require("../src/routes/chatCommandsOwner");
const { ChatCommandService } = require("../src/services/chatCommandService");
const { ChatOwnerReplies } = require("../src/services/chatOwnerReplies");
const { PlatformChatService } = require("../src/services/platformChat");

const CONFIG = {
  twitch: { enabled: true, channel: "https://www.twitch.tv/owner_login" },
  kick: { enabled: true, channel: "owner-kick", chatroomId: 42 },
  youtube: { enabled: true, channel: "@owner_login" },
};
const TWITCH_ID = "80000001-a159-4c58-a5b0-30a13142dddc";
const KICK_ID = "80000002-a159-4c58-a5b0-30a13142dddc";
const EVENT = { platform: "twitch", source: "owner_login", token: "fixture-a", id: TWITCH_ID, user: "Viewer", text: "!build" };
const GUIDE = "https://sc2tools.com/guides/pvz/stargate-into-glaives";

function providerTransport(options, writes) {
  return jest.fn(async (url, init) => {
    const path = new URL(url).pathname;
    if (init.method === "POST") {
      writes.push(JSON.parse(init.body));
      if (options.unknownDelivery) throw new Error("private-provider-error");
      if (path === "/helix/chat/messages") return Response.json({ data: [{ is_sent: true }] });
      if (path === "/public/v1/chat") return Response.json({ data: { is_sent: true } });
      return Response.json({ id: "provider-receipt" });
    }
    if (path === "/helix/shared_chat/session") {
      expect(new URL(url).searchParams.get("broadcaster_id")).toBe("42");
      if (options.sharedLookupFailed) return new Response("", { status: 503 });
      return Response.json({ data: options.sharedChat ? [{ session_id: "fixture-shared" }] : [] });
    }
    if (path === "/public/v1/channels") return Response.json({ data: [{ broadcaster_user_id: 42, slug: "owner-kick" }] });
    if (path === "/youtube/v3/channels") return Response.json({ items: [{ id: "owner-channel" }] });
    return Response.json({ items: ["video000001", "video000002"].map((id, index) => ({
      id, snippet: { channelId: index === 1 && options.foreignVideo ? "another-channel" : "owner-channel", liveChatId: `chat-${index}` },
      status: { lifeCycleStatus: "live" },
    })) });
  });
}

function fixture(options = {}) {
  let now = 10_000;
  const preferences = {
    multichat: options.config || CONFIG,
    chatCommands: { builtins: [{ id: "build", includeLink: true }], custom: options.custom || [] },
    chatbot: options.bot || {},
  };
  const users = { getPreferences: jest.fn(async (_owner, type) => preferences[type]) };
  const overlayTokens = {
    resolve: jest.fn(async token => ["fixture-a", "fixture-b"].includes(token) ? { userId: "owner-a" } : null),
    withWrite: jest.fn(async (_token, work) => work()),
  };
  const chatbot = {
    buildReply: jest.fn(async () => options.build ? options.build() : { text: "A".repeat(325), link: GUIDE }),
    commandLine: jest.fn(async (_token, command) => command === "opponent" ? "Private Player#123" : "Recorded reply."),
  };
  const writes = [];
  const publicFetch = jest.fn(async (url, init) => {
    expect(url).toMatch(/^https:\/\/kick\.com\/api\/v[12]\/channels\/owner-kick$/);
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(init.redirect).toBe("error");
    return options.kickLookupBlocked ? new Response("", { status: 403 }) : Response.json({ chatroom: { id: options.kickResolvedRoom || 42 } });
  });
  const provider = providerTransport(options, writes);
  const integrations = {
    config: { twitch: { clientId: "fixture-client" } },
    withChatGrant: jest.fn(async (_owner, platform, work) => {
      if (options.missingGrant) throw Object.assign(new Error("private-grant"), { code: "streaming_consent_required" });
      if (options.missingScope) throw Object.assign(new Error("private-grant"), { code: "streaming_scopes_missing" });
      return work({
        accessToken: "private-token", platformUserName: "owner_login",
        platformUserId: platform === "youtube" ? "owner-channel" : "42", boundedFetch: provider,
        assertCurrent: async () => { if (options.revoked) throw Object.assign(new Error("private-grant"), { code: "streaming_reconnect_required" }); },
      });
    }),
  };
  const commands = new ChatCommandService({ users, overlayTokens, chatbot, now: () => now });
  const replies = new ChatOwnerReplies({ users, overlayTokens, commands, platformChat: new PlatformChatService({ integrations, publicFetch }), now: () => now });
  const app = express();
  app.use(express.json());
  app.use(buildChatCommandsOwnerRouter({ commands, replies, auth: (req, res, next) => {
    const userId = req.get("authorization")?.replace(/^Bearer /, "");
    if (!["owner-a", "owner-b"].includes(userId)) { res.sendStatus(401); return; }
    req.auth = { userId };
    next();
  } }));
  return { commands, replies, app, writes, provider, integrations, preferences, overlayTokens, chatbot, tick: () => { now += 30_000; } };
}

const post = (fixture, row = EVENT, owner = "owner-a") =>
  request(fixture.app).post("/me/chat-commands/reply").set("Authorization", `Bearer ${owner}`).send(row);

beforeEach(() => { jest.spyOn(global, "fetch").mockImplementation(() => { throw new Error("Live provider access forbidden"); }); });
afterEach(() => jest.restoreAllMocks());

test.each([
  ["twitch", "owner_login", TWITCH_ID],
  ["kick", "42", KICK_ID],
  ["youtube", "video000002", "video000002:message"],
])("%s sends one server-composed reply to its exact source with the owner's grant", async (platform, source, id) => {
  const f = fixture();
  const response = await post(f, { ...EVENT, platform, source, id });
  expect(response.body).toEqual({ status: "sent" });
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(f.integrations.withChatGrant).toHaveBeenCalledWith("owner-a", platform, expect.any(Function));
  expect(f.writes).toHaveLength(1);
  const write = f.writes[0];
  if (platform === "twitch") expect(write).toMatchObject({ broadcaster_id: "42", sender_id: "42", reply_parent_message_id: TWITCH_ID });
  if (platform === "kick") expect(write).toMatchObject({ broadcaster_user_id: 42, type: "user", reply_to_message_id: KICK_ID });
  if (platform === "youtube") expect(write.snippet.liveChatId).toBe("chat-1");
  const message = write.message || write.content || write.snippet.textMessageDetails.messageText;
  expect(message).toMatch(new RegExp(` ${GUIDE}$`));
  expect(message.length).toBeLessThanOrEqual(platform === "youtube" ? 200 : 380);
  expect(JSON.stringify(response.body)).not.toContain("private-token");
});

test("only Clerk owners can act; OBS token, wrong owner, unknown source platform and outgoing text are refused", async () => {
  const f = fixture();
  await request(f.app).post("/me/chat-commands/reply").send(EVENT).expect(401);
  await post(f, EVENT, "fixture-a").expect(401);
  expect((await post(f, EVENT, "owner-b")).body.status).toBe("unavailable");
  await post(f, { ...EVENT, platform: "tiktok" }).expect(400);
  await post(f, { ...EVENT, outgoing: "arbitrary reply" }).expect(400);
  await post(f, { ...EVENT, text: "Hello!" }).expect(400);
  await post(f, { ...EVENT, id: "local-fallback-id" }).expect(400);
  await post(f, { ...EVENT, platform: "youtube", source: "video000001", id: "video000002:message" }).expect(400);
  expect(f.integrations.withChatGrant).not.toHaveBeenCalled();
});

test.each([
  [{}, { ...EVENT, source: "other_login" }],
  [{}, { ...EVENT, platform: "kick", source: "99" }],
  [{ kickResolvedRoom: 99 }, { ...EVENT, platform: "kick", source: "42", id: KICK_ID }],
  [{ kickLookupBlocked: true }, { ...EVENT, platform: "kick", source: "42", id: KICK_ID }],
  [{ foreignVideo: true }, { ...EVENT, platform: "youtube", source: "video000002", id: "video000002:message" }],
  [{ config: { ...CONFIG, youtube: { enabled: true, channel: "https://www.youtube.com/watch?v=video000001" } } },
    { ...EVENT, platform: "youtube", source: "video000002", id: "video000002:message" }],
  [{ missingGrant: true }, EVENT],
  [{ missingScope: true }, EVENT],
  [{ revoked: true }, EVENT],
  [{ sharedChat: true }, EVENT],
  [{ sharedLookupFailed: true }, EVENT],
])("mismatched, missing or revoked permission produces no provider write", async (options, event) => {
  const f = fixture(options);
  const response = await post(f, event);
  expect(response.body.status).toBe("failed");
  expect(JSON.stringify(response.body)).not.toContain("private-grant");
  expect(f.writes).toEqual([]);
});

test("the preview and on-stream lanes never send and existing chat cooldowns still apply", async () => {
  const f = fixture();
  const input = { command: "build", platform: "twitch", user: EVENT.user };
  const preview = await request(f.app).post("/me/chat-commands/try").set("Authorization", "Bearer owner-a")
    .send({ ...input, token: EVENT.token });
  expect(preview.body.text).toContain(GUIDE);
  expect((await f.commands.answer(EVENT.token, { ...input, onStream: true })).text).not.toContain(GUIDE);
  expect(f.writes).toEqual([]);
  expect((await post(f)).body.status).toBe("sent");
  expect((await f.commands.answer(EVENT.token, input)).status).toBe("cooldown");
});

test("same-row replies dedupe across owned tokens after cooldown, including an unconfirmed send", async () => {
  const f = fixture({ unknownDelivery: true });
  expect((await post(f)).body.status).toBe("unconfirmed");
  f.tick();
  expect((await post(f, { ...EVENT, token: "fixture-b", id: EVENT.id.toUpperCase() })).body.status).toBe("already_answered");
  expect(f.writes).toHaveLength(1);
});

test("a Shared Chat refusal leaves the reply and its link available after the session ends", async () => {
  const options = { sharedChat: true };
  const f = fixture(options);
  expect((await post(f)).body).toMatchObject({ status: "failed", message: expect.stringContaining("Shared Chat") });
  expect(f.chatbot.buildReply).not.toHaveBeenCalled();
  options.sharedChat = false;
  expect((await post(f)).body.status).toBe("sent");
  expect(f.writes[0].message).toContain(GUIDE);
});

test("Twitch bot replies and the connected owner's own message do not produce a duplicate or echo", async () => {
  const bot = fixture({ bot: { enabled: true, replyCommands: true, channel: "OWNER_LOGIN" } });
  expect((await post(bot)).body.status).toBe("bot_enabled");
  expect(bot.integrations.withChatGrant).not.toHaveBeenCalled();
  const own = fixture();
  expect((await post(own, { ...EVENT, user: "OWNER_LOGIN" })).body.status).toBe("own_message");
  expect(own.writes).toEqual([]);
});

test("public owner replies omit automatic player details and keep saved free-text custom content", async () => {
  const f = fixture({ custom: [
    { trigger: "private", response: "Meet {opponent}" },
    { trigger: "welcome", response: "Hello {user}. {record}" },
  ] });
  expect((await post(f, { ...EVENT, text: "!opponent" })).body.status).toBe("private_command");
  expect((await post(f, { ...EVENT, text: "!private" })).body.status).toBe("private_command");
  expect(f.chatbot.commandLine).not.toHaveBeenCalled();
  expect((await post(f, { ...EVENT, text: "!welcome" })).body.status).toBe("sent");
  expect(f.writes[0].message).toBe("Hello viewer. Recorded reply.");
});

test("a channel or token change during composition prevents a late provider write", async () => {
  let finish, started;
  const entered = new Promise(resolve => { started = resolve; });
  const f = fixture({ build: () => new Promise(resolve => { finish = resolve; started(); }) });
  const pending = f.replies.send("owner-a", EVENT);
  await entered;
  f.preferences.multichat = { ...CONFIG, twitch: { enabled: true, channel: "other_login" } };
  finish({ text: "Recorded reply", link: null });
  expect(await pending).toEqual({ status: "unavailable" });
  expect(f.writes).toEqual([]);
});
