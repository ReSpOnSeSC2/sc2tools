// @ts-nocheck
"use strict";

const { PlatformChatService, PlatformChatError } = require("../src/services/platformChat");
const { CHAT_SCOPES } = require("../src/services/platformOauthClients");

const CONFIG = { twitch: { enabled: true, channel: "fixture_streamer" }, kick: { enabled: true, channel: "fixture-streamer", chatroomId: 42 },
  youtube: { enabled: true, channel: "@fixture_streamer" }, tiktok: { enabled: true, username: "fixture_streamer" } };
function fixture(options = {}) {
  const writes = [], reads = [];
  const broadcasts = options.broadcasts || [
    { id: "video000001", snippet: { channelId: "UCfixture", liveChatId: "chat-one" }, status: { lifeCycleStatus: "live" } },
    { id: "video000002", snippet: { channelId: "UCfixture", liveChatId: "chat-two" }, status: { lifeCycleStatus: "live" } },
  ];
  const provider = jest.fn(async (url, init = {}) => {
    if (init.method === "POST") {
      writes.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
      if (options.write) return options.write(String(url), JSON.parse(init.body));
      if (String(url).includes("twitch")) return Response.json({ data: [{ message_id: "receipt", is_sent: true }] });
      if (String(url).includes("kick")) return Response.json({ data: { message_id: "receipt", is_sent: true } });
      return Response.json({ id: "youtube-receipt" });
    }
    reads.push(String(url));
    if (String(url).includes("kick")) return Response.json({ data: [{ broadcaster_user_id: 42, slug: "fixture-streamer" }] });
    if (String(url).includes("/channels?")) return Response.json({ items: [{ id: options.channelId || "UCfixture" }] });
    return Response.json({ items: broadcasts, ...(options.nextPageToken ? { nextPageToken: "more" } : {}) });
  });
  const integrations = {
    config: { twitch: { clientId: "fixture-client" } },
    statuses: jest.fn(async () => ({ platforms: ["twitch", "kick", "youtube"].map(platform => ({ platform, configured: true,
      connected: true, chatAvailable: true, chatConsent: options.consent !== false, scopes: CHAT_SCOPES[platform] })) })),
    withChatGrant: jest.fn(async (_owner, platform, callback) => callback({ accessToken: "private-access-token", platformUserId: platform === "youtube" ? "UCfixture" : "42",
      platformUserName: "fixture_streamer", boundedFetch: provider, assertCurrent: jest.fn(async () => {}) })),
  };
  return { service: new PlatformChatService({ integrations }), integrations, provider, writes, reads };
}

beforeEach(() => { jest.spyOn(global, "fetch").mockImplementation(() => { throw new Error("Real provider network forbidden"); }); });
afterEach(() => jest.restoreAllMocks());

test("status verifies configured destinations without sending and truthfully reports TikTok unavailable", async () => {
  const f = fixture(), rows = await f.service.status("owner", CONFIG);
  expect(rows.filter(row => row.available).map(row => row.platform)).toEqual(["twitch", "kick", "youtube"]);
  expect(rows.find(row => row.platform === "youtube").reason).toContain("2 active");
  expect(rows.find(row => row.platform === "tiktok")).toMatchObject({ available: false, reason: expect.stringContaining("unavailable") });
  expect(f.writes).toEqual([]); expect(JSON.stringify(rows)).not.toContain("private-access-token");
});

test("chat read connectivity never implies write permission", async () => {
  const f = fixture({ consent: false }), rows = await f.service.status("owner", CONFIG);
  expect(rows.every(row => !row.available)).toBe(true); expect(f.provider).not.toHaveBeenCalled();
});

test.each(["twitch", "kick"])("%s sends once as the connected owner to the saved matching destination", async platform => {
  const f = fixture(); expect(await f.service.send("owner", platform, "Hello chat!", CONFIG)).toMatchObject({ status: "sent" });
  expect(f.integrations.withChatGrant).toHaveBeenCalledWith("owner", platform, expect.any(Function));
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].body).toEqual(platform === "twitch" ? { broadcaster_id: "42", sender_id: "42", message: "Hello chat!" }
    : { broadcaster_user_id: 42, type: "user", content: "Hello chat!" });
  if (platform === "twitch") expect(f.writes[0].headers["Client-Id"]).toBe("fixture-client");
});

test.each(["twitch", "kick"])("%s account mismatches cannot send to another chat", async platform => {
  const f = fixture(); await expect(f.service.send("owner", platform, "Hello", { ...CONFIG, [platform]: { enabled: true, channel: "another_streamer" } }))
    .rejects.toMatchObject({ code: "chat_channel_mismatch" }); expect(f.writes).toEqual([]);
});

test("YouTube sends to every unique active owned chat while excluding inactive and other owners", async () => {
  const f = fixture({ broadcasts: [
    { id: "video000001", snippet: { channelId: "UCfixture", liveChatId: "shared-chat" }, status: { lifeCycleStatus: "live" } },
    { id: "video000002", snippet: { channelId: "UCfixture", liveChatId: "shared-chat" }, status: { lifeCycleStatus: "live" } },
    { id: "video000003", snippet: { channelId: "UCfixture", liveChatId: "second-chat" }, status: { lifeCycleStatus: "live" } },
    { id: "video000004", snippet: { channelId: "other-owner", liveChatId: "wrong-chat" }, status: { lifeCycleStatus: "live" } },
    { id: "video000005", snippet: { channelId: "UCfixture", liveChatId: "ended-chat" }, status: { lifeCycleStatus: "complete" } },
  ] });
  expect(await f.service.send("owner", "youtube", "Hello", CONFIG)).toMatchObject({ status: "sent", message: expect.stringContaining("2 of 2") });
  expect(f.writes.map(row => row.body.snippet.liveChatId)).toEqual(["shared-chat", "second-chat"]);
  expect(f.writes[0].body.snippet).toEqual({ liveChatId: "shared-chat", type: "textMessageEvent", textMessageDetails: { messageText: "Hello" } });
  const listing = new URL(f.reads.find(url => url.includes("liveBroadcasts")));
  expect(listing.searchParams.get("broadcastStatus")).toBe("active"); expect(listing.searchParams.has("mine")).toBe(false);
});

test("a configured YouTube video stays pinned to that exact owned live chat", async () => {
  const f = fixture(); await f.service.send("owner", "youtube", "Hello", { ...CONFIG, youtube: { enabled: true, channel: "https://youtube.com/watch?v=video000001" } });
  expect(f.writes).toHaveLength(1); expect(f.writes[0].body.snippet.liveChatId).toBe("chat-one");
  expect(f.reads).toHaveLength(1); expect(new URL(f.reads[0]).searchParams.get("id")).toBe("video000001");
});

test("YouTube handle mismatch, no live chat, or incomplete listing never causes a write", async () => {
  for (const opts of [{ channelId: "other-owner" }, { broadcasts: [] }, { nextPageToken: true }]) {
    const f = fixture(opts); await expect(f.service.send("owner", "youtube", "Hello", CONFIG)).rejects.toBeInstanceOf(PlatformChatError);
    expect(f.writes).toEqual([]);
  }
});

test.each(["", "line\r\nPRIVMSG #other :injection", "\0", "a".repeat(501), "\ud800"])("invalid chat text never reaches a provider: %j", async text => {
  const f = fixture(); await expect(f.service.send("owner", "twitch", text, CONFIG)).rejects.toMatchObject({ code: "chat_text_invalid" });
  expect(f.provider).not.toHaveBeenCalled();
});

test("YouTube's shorter limit is enforced before sending", async () => {
  const f = fixture(); await expect(f.service.send("owner", "youtube", "a".repeat(201), CONFIG)).rejects.toMatchObject({ code: "chat_text_invalid" });
  expect(f.provider).not.toHaveBeenCalled();
});

test("a provider is_sent:false receipt is a definite rejection, never a successful send", async () => {
  const f = fixture({ write: () => Response.json({ data: [{ is_sent: false, drop_reason: { message: "private-provider-value" } }] }) });
  await expect(f.service.send("owner", "twitch", "Hello", CONFIG)).rejects.toMatchObject({ code: "chat_message_rejected", deliveryUnknown: false });
  expect(f.writes).toHaveLength(1);
});

test.each(["network", "invalid-json", "missing-receipt", "server-error"])("ambiguous %s write is unknown and never replayed", async failure => {
  const f = fixture({ write: () => {
    if (failure === "network") throw new Error("private-provider-token");
    if (failure === "invalid-json") return new Response("broken");
    if (failure === "missing-receipt") return Response.json({});
    return Response.json({ message: "private-provider-token" }, { status: 503 });
  } });
  await expect(f.service.send("owner", "twitch", "Hello", CONFIG)).rejects.toMatchObject({ code: "chat_send_unconfirmed", deliveryUnknown: true, message: expect.not.stringContaining("private") });
  expect(f.writes).toHaveLength(1);
});

test("partial YouTube definitive rejections report confirmed subset", async () => {
  const f = fixture({ write: (_url, body) => body.snippet.liveChatId === "chat-one" ? Response.json({ id: "receipt" }) : Response.json({ error: "private" }, { status: 403 }) });
  expect(await f.service.send("owner", "youtube", "Hello", CONFIG)).toMatchObject({ status: "unknown", message: expect.stringContaining("1 of 2") }); expect(f.writes).toHaveLength(2);
});

test("partial YouTube unknown delivery is not represented as a safely retryable failure", async () => {
  const f = fixture({ write: (_url, body) => { if (body.snippet.liveChatId === "chat-two") throw new Error("private"); return Response.json({ id: "receipt" }); } });
  expect(await f.service.send("owner", "youtube", "Hello", CONFIG)).toMatchObject({ status: "unknown", message: expect.stringContaining("1 of 2") }); expect(f.writes).toHaveLength(2);
});

test("a grant failure after the provider accepted a message is never safely retryable", async () => {
  const f = fixture(), original = f.integrations.withChatGrant;
  f.integrations.withChatGrant = async (...args) => { await original(...args); throw new Error("private-release-failure"); };
  await expect(f.service.send("owner", "twitch", "Hello", CONFIG)).rejects.toMatchObject({ deliveryUnknown: true });
  expect(f.writes).toHaveLength(1);
});
