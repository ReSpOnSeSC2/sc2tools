// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { StreamingChannelService, mergeTags } = require("../src/services/streamingChannel");
const { buildAgentStreamingRouter } = require("../src/routes/agentStreaming");
const { streamTitleSession } = require("../src/services/streamTitleSession");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A provider fake that records every request and answers from `routes`. */
function harness(routes) {
  const calls = [];
  const boundedFetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined });
    const answer = routes(String(url), init.method || "GET");
    return answer instanceof Response ? answer : new Response(null, { status: 204 });
  };
  const integrations = { config: { twitch: { clientId: "client" } },
    withStreamingGrant: async (_user, platform, work) => work({ accessToken: "token", boundedFetch,
      platformUserId: platform === "twitch" ? "11" : "22", platformUserName: "streamer", assertCurrent: async () => {} }) };
  return { calls, service: new StreamingChannelService({ integrations }) };
}
const twitchRow = (extra) => json({ data: [{ broadcaster_id: "11", ...extra }] });
const kickRow = (extra) => json({ data: [{ broadcaster_user_id: "22", ...extra }] });
const writes = (calls) => calls.filter((call) => call.method === "PATCH");

describe("mergeTags", () => {
  test("keeps hand-set tags, replaces only our previous tags, and fills what remains", () => {
    const result = mergeTags(["English", "pvz", "Chill"], ["PvZ"], ["PvT", "Protoss"]);
    expect(result.merged).toEqual(["English", "Chill", "PvT", "Protoss"]);
    expect(result.added).toEqual(["PvT", "Protoss"]);
  });

  test("never passes ten tags and gives hand-set tags the places first", () => {
    const hand = Array.from({ length: 9 }, (_, index) => `Hand${index}`);
    expect(mergeTags(hand, [], ["One", "Two"]).merged).toEqual([...hand, "One"]);
    expect(mergeTags(hand.concat("Ten"), [], ["One"]).added).toEqual([]);
  });

  test("a tag the streamer already has by hand is not added twice", () => {
    expect(mergeTags(["protoss"], [], ["Protoss", "PvZ"]).merged).toEqual(["protoss", "PvZ"]);
  });
});

describe("setTags", () => {
  test("Twitch: writes the merged list once and reports what it added", async () => {
    const { service, calls } = harness(() => twitchRow({ tags: ["English", "Old"] }));
    const result = await service.setTags("u", "twitch", ["PvZ"], ["Old"]);
    expect(result).toMatchObject({ ok: true, status: "updated", tags: ["English", "PvZ"], added: ["PvZ"] });
    expect(writes(calls)).toEqual([expect.objectContaining({ body: { tags: ["English", "PvZ"] } })]);
  });

  test("an unchanged list sends no write", async () => {
    const { service, calls } = harness(() => twitchRow({ tags: ["PvZ"] }));
    expect(await service.setTags("u", "twitch", ["PvZ"], ["PvZ"])).toMatchObject({ status: "unchanged" });
    expect(writes(calls)).toHaveLength(0);
  });

  test("Kick: reads tags under stream and writes custom_tags", async () => {
    const { service, calls } = harness(() => kickRow({ stream: { is_live: true, custom_tags: ["Chill"] } }));
    await service.setTags("u", "kick", ["PvZ"], []);
    expect(writes(calls)[0].body).toEqual({ custom_tags: ["Chill", "PvZ"] });
  });

  test("Kick while offline cannot read hand-set tags, so nothing is written", async () => {
    const { service, calls } = harness(() => kickRow({ stream: { is_live: false, custom_tags: [] } }));
    expect(await service.setTags("u", "kick", ["PvZ"], [])).toMatchObject({ ok: true, status: "skipped" });
    expect(writes(calls)).toHaveLength(0);
  });

  test.each([["has space"], ["x".repeat(26)], ["Pv-Z"], [""], [7]])("a tag that breaks the rules (%p) is rejected before any request", async (tag) => {
    const { service, calls } = harness(() => twitchRow({ tags: [] }));
    const result = await service.setTags("u", "twitch", [tag], []).catch((error) => ({ code: error.code }));
    expect(result).toEqual({ code: "stream_tags_invalid" });
    expect(calls).toHaveLength(0);
  });

  test("more than ten tags are rejected", async () => {
    const { service } = harness(() => twitchRow({ tags: [] }));
    await expect(service.setTags("u", "twitch", Array.from({ length: 11 }, (_, i) => `T${i}`), [])).rejects.toMatchObject({ code: "stream_tags_invalid" });
  });

  test("a provider failure becomes a failed receipt, never a throw", async () => {
    const { service } = harness((url, method) => method === "PATCH" ? json({ message: "bad" }, 400) : twitchRow({ tags: [] }));
    expect(await service.setTags("u", "twitch", ["PvZ"], [])).toMatchObject({ ok: false, status: "failed" });
  });
});

describe("channel reads", () => {
  test("a channel row the provider does not return is a gap, not a reconnect instruction", async () => {
    const { service, calls } = harness(() => json({ data: [] }));
    const result = await service.setTags("u", "kick", ["PvZ"], []);
    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(result.reason).not.toMatch(/connect|permission/i);
    expect(writes(calls)).toHaveLength(0);
  });

  test("a row that belongs to another channel is never merged or written", async () => {
    const { service, calls } = harness(() => json({ data: [{ broadcaster_id: "99", tags: ["Theirs"] }] }));
    const result = await service.setTags("u", "twitch", ["PvZ"], []);
    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(writes(calls)).toHaveLength(0);
  });

  test("an unsupported platform never reaches a provider grant", async () => {
    const { service, calls } = harness(() => twitchRow({ tags: [] }));
    const withGrant = jest.spyOn(service.integrations, "withStreamingGrant");
    await expect(service.setTags("u", "youtube", ["PvZ"], [])).rejects.toMatchObject({ code: "stream_channel_platform_invalid" });
    await expect(service.ensureCategory("u", "youtube")).rejects.toMatchObject({ code: "stream_channel_platform_invalid" });
    expect(withGrant).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe("ensureCategory", () => {
  test("Twitch already on StarCraft II sends no write", async () => {
    const { service, calls } = harness(() => twitchRow({ game_id: "490422" }));
    expect(await service.ensureCategory("u", "twitch")).toMatchObject({ ok: true, status: "unchanged" });
    expect(writes(calls)).toHaveLength(0);
  });

  test("Twitch under another category is switched", async () => {
    const { service, calls } = harness(() => twitchRow({ game_id: "509658" }));
    expect(await service.ensureCategory("u", "twitch")).toMatchObject({ status: "updated" });
    expect(writes(calls)[0].body).toEqual({ game_id: "490422" });
  });

  test("Kick looks the category up once and switches only when different", async () => {
    const { service, calls } = harness((url) => url.includes("/categories")
      ? json({ data: [{ id: 99, name: "StarCraft II Campaign" }, { id: 5, name: "StarCraft II" }] })
      : kickRow({ category: { id: 7, name: "Just Chatting" }, stream: { is_live: true } }));
    expect(await service.ensureCategory("u", "kick")).toMatchObject({ status: "updated" });
    expect(writes(calls)[0].body).toEqual({ category_id: 5 });
    await service.ensureCategory("u", "kick");
    expect(calls.filter((call) => call.url.includes("/categories"))).toHaveLength(1);
  });

  test("Kick already on StarCraft II sends no write", async () => {
    const { service, calls } = harness((url) => url.includes("/categories")
      ? json({ data: [{ id: 5, name: "StarCraft II" }] }) : kickRow({ category: { id: 5 } }));
    expect(await service.ensureCategory("u", "kick")).toMatchObject({ status: "unchanged" });
    expect(writes(calls)).toHaveLength(0);
  });

  test("a missing Kick category is a failed receipt", async () => {
    const { service } = harness((url) => url.includes("/categories") ? json({ data: [] }) : kickRow({ category: { id: 7 } }));
    expect(await service.ensureCategory("u", "kick")).toMatchObject({ ok: false, status: "failed" });
  });
});

describe("routes", () => {
  const app = (service) => {
    const server = express();
    server.use(express.json());
    server.use("/v1", buildAgentStreamingRouter({ auth: (req, _res, next) => { req.auth = { userId: "u", source: "device" }; next(); },
      integrations: {}, streamingTitles: {}, streamingChannel: service }));
    server.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code }));
    return server;
  };

  test("tags and category pass only their documented fields", async () => {
    const service = { setTags: jest.fn(async () => ({ ok: true })), ensureCategory: jest.fn(async () => ({ ok: true })) };
    await request(app(service)).post("/v1/agent/streaming/tags").send({ platform: "twitch", tags: ["PvZ"], previous: [] }).expect(200);
    expect(service.setTags).toHaveBeenCalledWith("u", "twitch", ["PvZ"], []);
    await request(app(service)).post("/v1/agent/streaming/category").send({ platform: "kick" }).expect(200);
    await request(app(service)).post("/v1/agent/streaming/category").send({ platform: "kick", userId: "x" }).expect(400);
    await request(app(undefined)).post("/v1/agent/streaming/tags").send({ platform: "twitch", tags: [] }).expect(400);
  });
});

describe("session tag context", () => {
  const cursor = { sort() { return this; }, limit() { return this; }, toArray: async () => [] };
  const run = (match, extras) => streamTitleSession({ games: { find: () => cursor } },
    { todaySession: async () => ({ wins: 0, losses: 0 }) }, "owner",
    () => match, undefined, undefined, extras);
  const live = (map) => ({ phase: "match_started", receivedAt: Date.now(), gameKey: "g", isReplay: false,
    user: { name: "Me", race: "Protoss" }, map, opponent: { name: "Them" },
    players: [{ name: "Me", type: "user", race: "Protoss", team_id: 1 }, { name: "Them", type: "user", race: "Zerg", team_id: 2 }] });

  test("a map outside the ladder pool is a custom game; the edition suffix does not matter", async () => {
    const extras = { ladderMaps: async () => ["Blackrock", "Gemgarden LE"], hasActiveSeries: async () => true };
    expect((await run(live("Blackrock LE"), extras)).tagContext).toEqual({ series: true, custom: false });
    expect((await run(live("Gemgarden"), extras)).tagContext.custom).toBe(false);
    const result = await run(live("Frozen Temple"), extras);
    expect(result.tagContext.custom).toBe(true);
    expect(result.currentMatch.opponentRace).toBe("Zerg");
  });

  test("an unknown pool or a failed lookup never marks a game custom", async () => {
    expect((await run(live("Anything"), { ladderMaps: async () => [] })).tagContext).toEqual({ series: false });
    const failing = { ladderMaps: async () => { throw new Error("down"); }, hasActiveSeries: async () => { throw new Error("down"); } };
    expect((await run(live("Anything"), failing)).tagContext).toEqual({ series: false });
  });
});
