// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { randomUUID } = require("crypto");
const { YoutubeStreamingService } = require("../src/services/youtubeStreaming");
const { buildYoutubeStreamingRouter } = require("../src/routes/youtubeStreaming");
const NOW = Date.parse("2026-10-08T12:00:00Z");
const CHANNEL = "owned-channel";
const clone = (value) => structuredClone(value);
const error = (code) => Object.assign(new Error(code), { code, status: 409 });
function intent() {
  return { snippet: { title: "Pair test", description: "Saved description", categoryId: "20", scheduledStartTime: new Date(NOW + 60_000).toISOString() }, status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false }, contentDetails: { enableAutoStart: true, enableAutoStop: true, monitorStream: { enableMonitorStream: false } } };
}
function stream(id) {
  return { id, snippet: { channelId: CHANNEL, title: id }, status: { streamStatus: "inactive" }, cdn: { ingestionInfo: { streamName: "MOCK_SECRET_KEY" } } };
}

class MockLedger {
  rows = new Map();
  streamClaims = new Map();
  indexes = 0;
  async ensureIndexes() { this.indexes += 1; }
  key(args) { return args.userId + ":" + args.operationId; }
  result(row) { return row?.broadcast ? { phase: "succeeded", broadcast: clone(row.broadcast) } : { phase: "uncertain" }; }
  async inspect(args) {
    const row = this.rows.get(this.key(args));
    if (row && JSON.stringify(row.intent) !== JSON.stringify(args.intent)) throw error("youtube_operation_intent_conflict");
    return row ? this.result(row) : null;
  }
  async execute(args, insert) {
    if (this.rows.has(this.key(args))) return this.inspect(args);
    const row = { ...clone(args), marker: "\n\n[SC2Tools: " + randomUUID().replaceAll("-", "") + "]" };
    this.rows.set(this.key(args), row);
    try {
      const actual = await insert({ marker: row.marker, intent: clone(row.intent) });
      if (actual.snippet.description !== row.intent.snippet.description + row.marker) throw error("youtube_created_broadcast_unverified");
      row.broadcast = clone(actual);
      row.broadcast.snippet.description = row.intent.snippet.description;
    } catch { /* No repeated insert after an ambiguous response. */ }
    return this.result(row);
  }
  async reconcile(args, lookup) {
    const row = this.rows.get(this.key(args));
    if (!row || row.expectedChannelId !== args.expectedChannelId) return null;
    if (!row.broadcast) {
      const matches = (await lookup()).filter((item) => item.snippet.channelId === row.expectedChannelId && item.snippet.description === row.intent.snippet.description + row.marker && item.snippet.title === row.intent.snippet.title);
      if (matches.length === 1) {
        row.broadcast = clone(matches[0]);
        row.broadcast.snippet.description = row.intent.snippet.description;
      }
    }
    return this.result(row);
  }
  find(args) { return Array.from(this.rows.values()).find((row) => row.userId === args.userId && row.expectedChannelId === args.expectedChannelId && row.broadcast?.id === args.broadcastId); }
  async getOwnedBroadcast(args) {
    const row = this.find(args);
    return row ? { ...clone(row.broadcast), ...(row.selectedStreamId ? { selectedStreamId: row.selectedStreamId } : {}) } : null;
  }
  async markBound(args) {
    const row = this.find(args);
    if (!row || row.selectedStreamId && row.selectedStreamId !== args.streamId) throw error("youtube_broadcast_stream_conflict");
    row.selectedStreamId = args.streamId;
    if (args.broadcast) row.broadcast.contentDetails.boundStreamId = args.streamId;
  }
  async claimStream(args, verifyPrevious) {
    const key = args.userId + ":" + args.expectedChannelId + ":" + args.streamId;
    const previous = this.streamClaims.get(key);
    if (previous && previous !== args.broadcastId && !await verifyPrevious(previous)) throw error("youtube_stream_reserved");
    this.streamClaims.set(key, args.broadcastId);
  }
  async sanitizeOwnedBroadcast(args) {
    const row = this.find({ ...args, broadcastId: args.broadcast.id });
    if (!row) throw error("youtube_broadcast_not_owned");
    const result = clone(args.broadcast);
    if (result.snippet.description.includes(row.marker)) {
      result.snippet.description = result.snippet.description.replace(row.marker, "");
      result.metadataPending = true;
    }
    return result;
  }
}

function setup() {
  const rows = new Map(), streams = [stream("horizontal-key-id"), stream("portrait-key-id")], calls = [];
  const ledger = new MockLedger();
  const state = { lostInsert: false, failMetadata: false, paginateForever: false, revision: "revision-one", tamperSnippet: "", malformedSnippet: null, laggingOccupied: false, providerError: null };
  const integrations = { withStreamingGrant: async (_user, _platform, action) => action({
    platformUserId: CHANNEL, platformUserName: "Owned channel", connectionRevision: state.revision,
    accessToken: "MOCK_OAUTH_TOKEN", assertCurrent: async () => {},
    boundedFetch: async (raw, options) => {
      const url = new URL(raw), resource = url.pathname.split("/v3/")[1];
      const method = options.method, body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ resource, method, params: Object.fromEntries(url.searchParams), body });
      if (state.providerError) return { ok: false, status: state.providerError.status, text: async () => JSON.stringify({ error: { message: "MOCK_PRIVATE_TOKEN", errors: [{ reason: state.providerError.reason }] } }) };
      let payload;
      if (resource === "liveStreams") payload = { items: url.searchParams.has("id") ? streams.filter((row) => url.searchParams.get("id").split(",").includes(row.id)) : streams };
      else if (resource === "liveBroadcasts" && method === "POST") {
        const row = { id: "owned-event-" + (rows.size + 1), snippet: { ...clone(body.snippet), channelId: CHANNEL }, status: { ...body.status, lifeCycleStatus: "created" }, contentDetails: clone(body.contentDetails) };
        rows.set(row.id, row); payload = row;
        if (state.lostInsert) throw new Error("Mock lost response after insert.");
      } else if (resource === "liveBroadcasts") {
        const filter = url.searchParams.get("broadcastStatus");
        payload = { items: Array.from(rows.values()).filter((row) => url.searchParams.has("id") ? url.searchParams.get("id").split(",").includes(row.id) : filter === "active" ? row.status.lifeCycleStatus === "live" : filter === "upcoming" ? !["live", "complete", "revoked"].includes(row.status.lifeCycleStatus) : true) };
        if (state.laggingOccupied && filter) payload.items = [];
        if (state.paginateForever) payload = { items: [], nextPageToken: "more-pages" };
      } else if (resource === "liveBroadcasts/bind") {
        const row = rows.get(url.searchParams.get("id"));
        row.contentDetails.boundStreamId = url.searchParams.get("streamId");
        row.status.lifeCycleStatus = "ready"; payload = row;
      } else if (resource === "videos" && method === "GET") {
        const row = rows.get(url.searchParams.get("id"));
        payload = { items: row ? [{ id: row.id, snippet: { ...row.snippet, categoryId: "20", tags: ["preserve"], defaultLanguage: "en", publishedAt: "read-only" } }] : [] };
        if (state.malformedSnippet && payload.items.length) Object.assign(payload.items[0].snippet, state.malformedSnippet);
      } else if (resource === "videos" && method === "PUT") {
        if (state.failMetadata) throw new Error("Mock metadata failure.");
        const row = rows.get(body.id);
        row.snippet = { ...row.snippet, ...body.snippet }; payload = { id: row.id, snippet: clone(row.snippet) };
        if (state.tamperSnippet === "omit-tags") delete payload.snippet.tags;
        if (state.tamperSnippet === "change-tags") payload.snippet.tags = ["altered"];
        if (state.tamperSnippet === "change-category") payload.snippet.categoryId = "22";
      } else throw new Error("Unexpected mocked provider request.");
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    },
  }) };
  const service = new YoutubeStreamingService({ integrations, ledger, now: () => NOW });
  const payload = { operation_id: randomUUID(), expected_channel_id: CHANNEL, body: intent() };
  const app = express(); app.use(express.json());
  const auth = (req, _res, next) => { req.auth = { userId: req.headers["x-owner"] || "user-one", source: "device" }; next(); };
  app.use("/v1", buildYoutubeStreamingRouter({ auth, youtubeStreaming: service }));
  return { rows, streams, calls, ledger, state, service, payload, app };
}

test("catalog redacts ingestion credentials and cache is isolated by user/revision", async () => {
  const s = setup();
  const first = await s.service.catalog("user-one");
  expect(JSON.stringify(first)).not.toContain("MOCK_SECRET");
  expect(JSON.stringify(first)).not.toContain("MOCK_OAUTH");
  await s.service.catalog("user-one"); expect(s.calls.length).toBe(1);
  await s.service.catalog("user-two"); expect(s.calls.length).toBe(2);
  s.state.revision = "revision-two";
  await s.service.catalog("user-one"); expect(s.calls.length).toBe(3);
});

test("create UUID replay returns same owned ID and inserts once", async () => {
  const s = setup();
  const first = await s.service.create("user-one", s.payload);
  const second = await s.service.create("user-one", s.payload);
  expect(first.id).toBe(second.id);
  expect(s.calls.filter((call) => call.resource === "liveBroadcasts" && call.method === "POST")).toHaveLength(1);
  expect(s.rows.get(first.id).snippet.description).toBe(s.payload.body.snippet.description);
  expect(s.rows.get(first.id).snippet.categoryId).toBe("20");
  expect(first.snippet.categoryId).toBe("20");
  expect(JSON.stringify(first)).not.toContain("SC2Tools:");
  expect(s.ledger.indexes).toBe(1);
});

test("ambiguous creation cannot insert again; explicit nonce recovery returns owned ID", async () => {
  const s = setup(); s.state.lostInsert = true;
  await expect(s.service.create("user-one", s.payload)).rejects.toMatchObject({ code: "creation_uncertain" });
  s.state.lostInsert = false;
  await expect(s.service.create("user-one", s.payload)).rejects.toMatchObject({ code: "creation_uncertain" });
  const recovered = await s.service.read("user-one", "recover_create", { operation_id: s.payload.operation_id });
  expect(recovered.id).toBe("owned-event-1");
  expect(recovered.snippet.description).toBe(s.payload.body.snippet.description);
  expect(s.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
  await expect(s.service.read("user-two", "recover_create", { operation_id: s.payload.operation_id })).rejects.toMatchObject({ code: "creation_uncertain" });
});

test("nonce cleanup failure reports pending and read strips only ledger-owned marker", async () => {
  const s = setup(); s.state.failMetadata = true;
  const row = await s.service.create("user-one", s.payload);
  expect(row.metadataPending).toBe(true);
  const read = await s.service.read("user-one", "broadcasts_by_ids", { ids: [row.id] });
  expect(read.items[0].metadataPending).toBe(true);
  expect(read.items[0].snippet.description).toBe("Saved description");
  s.state.failMetadata = false;
  const saved = await s.service.updateMetadata("user-one", { expected_channel_id: CHANNEL, broadcast_id: row.id, title: "Updated", description: "Updated description" });
  expect(saved.metadataPending).not.toBe(true);
  const put = s.calls.filter((call) => call.resource === "videos" && call.method === "PUT").at(-1);
  expect(put.body.snippet.tags).toEqual(["preserve"]);
  expect(put.body.snippet.categoryId).toBe("20");
  expect(put.body.snippet.publishedAt).toBeUndefined();
  expect(put.body.status).toBeUndefined();
});

test("bind pins selected own inactive reusable stream and is idempotent", async () => {
  const s = setup(), row = await s.service.create("user-one", s.payload);
  const args = { expected_channel_id: CHANNEL, broadcast_id: row.id, stream_id: s.streams[0].id };
  const bound = await s.service.bind("user-one", args);
  expect(bound.contentDetails.boundStreamId).toBe(args.stream_id);
  await s.service.bind("user-one", args);
  expect(s.calls.filter((call) => call.resource === "liveBroadcasts/bind")).toHaveLength(1);
  await expect(s.service.bind("user-one", { ...args, stream_id: s.streams[1].id })).rejects.toMatchObject({ code: "youtube_ownership_changed" });
  await expect(s.service.updateMetadata("user-two", { expected_channel_id: CHANNEL, broadcast_id: row.id, title: "Wrong user", description: "" })).rejects.toMatchObject({ code: "youtube_ownership_changed" });
});

test.each(["omit-tags", "change-tags", "change-category"])("metadata never claims success if preserved snippet field is changed: %s", async (mode) => {
  const s = setup(), row = await s.service.create("user-one", s.payload);
  s.state.tamperSnippet = mode;
  await expect(s.service.updateMetadata("user-one", { expected_channel_id: CHANNEL, broadcast_id: row.id, title: "Updated title", description: "Updated description" })).rejects.toMatchObject({ code: "youtube_metadata_unverified" });
  expect(s.calls.filter((call) => call.resource === "videos" && call.method === "PUT")).toHaveLength(2);
});

test.each([{ tags: [42] }, { defaultLanguage: 42 }, { categoryId: {} }])("malformed preserved metadata rejects before PUT: %j", async (malformed) => {
  const s = setup(), row = await s.service.create("user-one", s.payload);
  const before = s.calls.filter((call) => call.resource === "videos" && call.method === "PUT").length;
  s.state.malformedSnippet = malformed;
  await expect(s.service.updateMetadata("user-one", { expected_channel_id: CHANNEL, broadcast_id: row.id, title: "Updated title", description: "Updated description" })).rejects.toMatchObject({ code: "youtube_metadata_unverified" });
  expect(s.calls.filter((call) => call.resource === "videos" && call.method === "PUT")).toHaveLength(before);
});

test("foreign occupied event and active ingest each block before any bind POST", async () => {
  const s = setup(), row = await s.service.create("user-one", s.payload);
  const args = { expected_channel_id: CHANNEL, broadcast_id: row.id, stream_id: s.streams[0].id };
  s.rows.set("foreign-event", { ...clone(s.rows.get(row.id)), id: "foreign-event", contentDetails: { ...row.contentDetails, boundStreamId: args.stream_id } });
  await expect(s.service.bind("user-one", args)).rejects.toMatchObject({ code: "youtube_foreign_event_conflict" });
  s.rows.delete("foreign-event"); s.streams[0].status.streamStatus = "active";
  await expect(s.service.bind("user-one", args)).rejects.toMatchObject({ code: "cloud_ingest_active" });
  expect(s.calls.filter((call) => call.resource === "liveBroadcasts/bind")).toHaveLength(0);
});

test("durable stream claim rejects a second device even when occupied listings lag", async () => {
  const s = setup(), first = await s.service.create("user-one", s.payload);
  const bind = { expected_channel_id: CHANNEL, broadcast_id: first.id, stream_id: s.streams[0].id };
  await s.service.bind("user-one", bind);
  const second = await s.service.create("user-one", { ...s.payload, operation_id: randomUUID() });
  s.state.laggingOccupied = true;
  await expect(s.service.bind("user-one", { ...bind, broadcast_id: second.id })).rejects.toMatchObject({ code: "youtube_stream_reserved" });
  expect(s.calls.filter((call) => call.resource === "liveBroadcasts/bind")).toHaveLength(1);
  s.rows.get(first.id).status.lifeCycleStatus = "complete";
  await s.service.bind("user-one", { ...bind, broadcast_id: second.id });
  expect(s.calls.filter((call) => call.resource === "liveBroadcasts/bind")).toHaveLength(2);
});

test("unknown inventory pagination and provider identity fail closed", async () => {
  const s = setup(); s.state.paginateForever = true;
  await expect(s.service.read("user-one", "occupied_broadcasts")).rejects.toMatchObject({ code: "youtube_inventory_unknown" });
  s.state.paginateForever = false; s.streams[0].snippet.channelId = "another-channel";
  await expect(s.service.catalog("user-one")).rejects.toMatchObject({ code: "youtube_ownership_changed" });
  expect(s.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
});

test("narrow HTTP route rejects arbitrary proxy/user fields and sanitizes errors", async () => {
  const s = setup();
  expect((await request(s.app).get("/v1/streaming/youtube/read?operation=delete")).status).toBe(400);
  expect((await request(s.app).post("/v1/streaming/youtube/create").send({ ...s.payload, userId: "user-two" })).status).toBe(400);
  const created = await request(s.app).post("/v1/streaming/youtube/create").send(s.payload);
  expect(created.status).toBe(200);
  expect(created.headers["cache-control"]).toBe("no-store");
  s.service.read = async () => { throw new Error("MOCK_SECRET_TOKEN at private.example"); };
  const bad = await request(s.app).get("/v1/streaming/youtube/read?operation=occupied_broadcasts");
  expect(bad.status).toBe(502);
  expect(JSON.stringify(bad.body)).not.toContain("MOCK_SECRET");
});

test("creation settings and expected channel validate before Google insert", async () => {
  const s = setup();
  await expect(s.service.create("user-one", { ...s.payload, expected_channel_id: "another-channel" })).rejects.toMatchObject({ code: "youtube_ownership_changed" });
  for (const change of [body => { body.contentDetails.enableAutoStart = false; }, body => { body.status.privacyStatus = "not-public"; }, body => { body.snippet.title = "<bad>"; }]) {
    const body = intent(); change(body);
    await expect(s.service.create("user-one", { ...s.payload, body })).rejects.toMatchObject({ status: 400 });
  }
  expect(s.calls).toHaveLength(0);
});

test.each([[403, "quotaExceeded", 429], [403, "dailyLimitExceeded", 429], [403, "rateLimitExceeded", 429], [403, "userRateLimitExceeded", 429], [403, "insufficientPermissions", 403], [429, "other", 429]])("provider error %s/%s is translated without exposing its private body", async (status, reason, translated) => {
  const s = setup(); s.state.providerError = { status, reason };
  await expect(s.service.catalog("user-one")).rejects.toMatchObject({ status: translated });
  const response = await request(s.app).get("/v1/streaming/youtube/catalog");
  expect(response.status).toBe(translated);
  expect(response.body.providerHttpStatus).toBe(status);
  expect(JSON.stringify(response.body)).not.toContain("MOCK_PRIVATE");
});

test.each([400, 404, 405, 500, 503, 599])("catalog preserves only safe provider HTTP status %s for diagnosis", async (providerHttpStatus) => {
  const s = setup(); s.state.providerError = { status: providerHttpStatus, reason: "MOCK_PRIVATE_REASON" };
  const response = await request(s.app).get("/v1/streaming/youtube/catalog");
  expect(response.status).toBe(502);
  expect(response.body).toEqual({ error: "youtube_provider_unavailable", providerHttpStatus });
  expect(JSON.stringify(response.body)).not.toMatch(/MOCK_PRIVATE|MOCK_OAUTH|https?:/);
});

test.each([399, 600, 400.5, "400", null, {}, true])("route omits invalid provider HTTP diagnostics: %j", async (providerHttpStatus) => {
  const s = setup();
  s.service.catalog = async () => {
    throw Object.assign(new Error("MOCK_PRIVATE_TOKEN at https://private.example"), {
      code: "youtube_provider_unavailable", status: 502, providerHttpStatus,
      body: "MOCK_PRIVATE_BODY", url: "https://private.example",
    });
  };
  const response = await request(s.app).get("/v1/streaming/youtube/catalog");
  expect(response.body).toEqual({ error: "youtube_provider_unavailable" });
});
