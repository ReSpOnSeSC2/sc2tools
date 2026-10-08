// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { PlatformIntegrationsService } = require("../src/services/platformIntegrations");
const { StreamingTitlesService } = require("../src/services/streamingTitles");
const { buildAgentStreamingRouter } = require("../src/routes/agentStreaming");
const { buildPlatformIntegrationsRouter } = require("../src/routes/platformIntegrations");
const oauth = require("../src/services/platformOauthClients");

const NOW = Date.parse("2026-10-08T12:00:00Z");
const KEY = Buffer.alloc(32, 17);
function get(row, path) { return path.split(".").reduce((value, key) => value?.[key], row); }
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some((option) => matches(row, option));
    const observed = get(row, key);
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (Object.hasOwn(value, "$exists")) return (observed !== undefined) === value.$exists;
      if (Object.hasOwn(value, "$ne")) return observed !== value.$ne;
      if (Object.hasOwn(value, "$lte")) return observed !== undefined && observed <= value.$lte;
      if (Object.hasOwn(value, "$gt")) return observed !== undefined && observed > value.$gt;
    }
    return observed === value;
  });
}
function apply(row, update) {
  const result = { ...row };
  for (const [key, value] of Object.entries(update.$set || {})) {
    if (key.startsWith("metadata.")) result.metadata = { ...result.metadata, [key.slice(9)]: value };
    else result[key] = value;
  }
  for (const key of Object.keys(update.$unset || {})) delete result[key];
  return result;
}
function fakeDb() {
  const rows = new Map(), states = new Map();
  const key = (filter) => `${filter.userId}:${filter.platform}`;
  return { rows, states,
    platformConnections: {
      async updateOne(filter, update, options) {
        const row = rows.get(key(filter));
        if (row && !matches(row, filter)) {
          if (options?.upsert) throw Object.assign(new Error("duplicate"), { code: 11000 });
          return { matchedCount: 0 };
        }
        if (!row && !options?.upsert) return { matchedCount: 0 };
        rows.set(key(filter), apply({ ...row, ...(!row ? update.$setOnInsert : {}) }, update));
        return { matchedCount: row ? 1 : 0 };
      },
      async findOne(filter) { const row = rows.get(key(filter)); return row && matches(row, filter) ? row : null; },
      async findOneAndUpdate(filter, update) {
        const row = rows.get(key(filter));
        if (!row || !matches(row, filter)) return null;
        const next = apply(row, update);
        rows.set(key(filter), next);
        return next;
      },
      find(filter) { return { project() { return this; }, limit() { return this; }, async toArray() {
        return [...rows.values()].filter((row) => matches(row, filter));
      } }; },
      async deleteOne(filter) { const row = rows.get(key(filter));
        if (!row || !matches(row, filter)) return { deletedCount: 0 };
        rows.delete(key(filter)); return { deletedCount: 1 }; },
    },
    platformOauthStates: {
      async insertOne(row) { states.set(row.stateHash, row); },
      async findOneAndDelete(filter) { const row = states.get(filter.stateHash);
        if (!row || !matches(row, filter)) return null;
        states.delete(filter.stateHash); return row; },
    }, platformWebhookReceipts: {}, platformEvents: {},
  };
}
function fixture(db = fakeDb()) {
  const titles = { twitch: "Old Twitch", kick: "Old Kick" };
  const calls = [];
  const other = { category_id: 20, tags: ["Protoss"], channel_description: "Keep this" };
  let wrongIdentity = false, ignoreWrite = false, rejectedWrite = false;
  let kickIsLive = true, hideKickTitle = false, delayedKickReads = 0, previousKickTitle = null;
  const fetchImpl = jest.fn(async (url, init = {}) => {
    url = String(url); calls.push({ url, init });
    const platform = url.includes("twitch") ? "twitch" : "kick";
    if (url.includes("oauth2/validate")) return Response.json({ user_id: wrongIdentity ? "999" : "42", login: "fixture_streamer", client_id: "own-twitch", scopes: oauth.STREAMING_SCOPES.twitch });
    if (url.includes("oauth/token/introspect")) return Response.json({ data: { active: true, token_type: "user", client_id: "own-kick", scope: oauth.STREAMING_SCOPES.kick.join(" ") } });
    if (url.includes("/public/v1/users")) return Response.json({ data: [{ user_id: wrongIdentity ? 999 : 42, name: "fixture_streamer" }] });
    if (url.includes("/oauth2/token") || url.includes("/oauth/token")) return Response.json({ access_token: "fixture-rotated-access", refresh_token: "fixture-rotated-refresh", expires_in: 4000, scope: oauth.STREAMING_SCOPES[platform] });
    if (url.includes("/channels")) {
      if (init.method === "PATCH") {
        if (rejectedWrite) return Response.json({ message: "fixture-private-token-url-title" }, { status: 403 });
        if (platform === "kick") previousKickTitle = titles.kick;
        if (!ignoreWrite) titles[platform] = JSON.parse(init.body)[platform === "twitch" ? "title" : "stream_title"];
        return new Response(null, { status: 204 });
      }
      let kickReadback = hideKickTitle ? "" : titles.kick;
      if (platform === "kick" && previousKickTitle !== null && delayedKickReads > 0) {
        kickReadback = previousKickTitle;
        delayedKickReads -= 1;
      }
      return Response.json({ data: [{ ...other,
        ...(platform === "twitch" ? { broadcaster_id: wrongIdentity ? "999" : "42", title: titles.twitch }
          : { broadcaster_user_id: wrongIdentity ? 999 : 42, stream_title: kickReadback,
            stream: { is_live: kickIsLive, key: "fixture-private-stream-key", url: "fixture-private-ingest" } }) }] });
    }
    throw new Error("Unexpected mock provider URL; no outbound network exists in this suite.");
  });
  const integrations = new PlatformIntegrationsService(db, { config: { enabled: true, encryptionKey: KEY,
    twitch: { clientId: "own-twitch", clientSecret: "fixture-secret", redirectUri: "https://api.sc2tools.com/v1/integrations/twitch/callback" },
    kick: { clientId: "own-kick", clientSecret: "fixture-secret", redirectUri: "https://api.sc2tools.com/v1/integrations/kick/callback" },
    youtube: { clientId: "own-youtube", clientSecret: "fixture-secret", redirectUri: "https://api.sc2tools.com/v1/integrations/youtube/callback" },
  }, overlayTokens: { list: async () => [] }, fetchImpl, now: () => NOW });
  const wait = jest.fn(async () => {});
  const service = new StreamingTitlesService({ integrations, wait });
  return { db, integrations, service, calls, titles, other, fetchImpl,
    wait, kickLive(value, hideTitle = false) { kickIsLive = value; hideKickTitle = hideTitle; },
    delayKickReads(count) { delayedKickReads = count; },
    rejectIdentity() { wrongIdentity = true; }, ignoreWrite() { ignoreWrite = true; }, rejectWrite() { rejectedWrite = true; },
    async connect(platform, metadata = {}, scopes = oauth.STREAMING_SCOPES[platform], expiresAt = new Date(NOW + 4_000_000)) {
      return integrations.vault.saveConnection("user-1", platform, { accessToken: "fixture-access", refreshToken: "fixture-refresh",
        expiresAt, scopes, platformUserId: "42", platformUserName: "fixture_streamer",
        metadata: { streamingConsent: true, ...metadata } });
    },
  };
}
beforeEach(() => { jest.spyOn(global, "fetch").mockImplementation(() => { throw new Error("Real provider network forbidden"); }); });
afterEach(() => jest.restoreAllMocks());

describe("central user-owned stream titles", () => {
  test("updates title only on both platforms and verifies readback without exporting credentials", async () => {
    const f = fixture(); await f.connect("twitch"); await f.connect("kick");
    const before = { ...f.other };
    const result = await f.service.updateTitle("user-1", " Shared title 🎮 ");
    expect(result.platforms.every((row) => row.streamingReady && row.title === "Shared title 🎮")).toBe(true);
    expect(result.platforms.every((row) => row.accepted && row.titleVerified && row.titleStatus === "verified")).toBe(true);
    const writes = f.calls.filter((call) => call.init.method === "PATCH");
    expect(writes.map((call) => JSON.parse(call.init.body))).toEqual(expect.arrayContaining([{ title: "Shared title 🎮" }, { stream_title: "Shared title 🎮" }]));
    expect(f.other).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("fixture-access");
    expect([...f.db.rows.values()].every((row) => !row.streamingLease)).toBe(true);
    expect(writes.every((call) => call.init.redirect === "error" && call.init.signal)).toBe(true);
  });
  test("notification scopes or absent streaming consent cannot update titles", async () => {
    for (const denied of ["scope", "consent"]) {
      const f = fixture();
      await f.connect("twitch", denied === "consent" ? { streamingConsent: false } : {}, denied === "scope" ? oauth.TWITCH_SCOPES : oauth.STREAMING_SCOPES.twitch);
      const result = await f.service.updateTitle("user-1", "New title", ["twitch"]);
      expect(result.platforms[0].streamingReady).toBe(false);
      expect(result.platforms[0].connectionInvalid).toBe(true);
      expect(f.calls).toHaveLength(0);
    }
  });
  test("invalid metadata or platform selection is rejected before credentials/provider calls", async () => {
    const f = fixture(); await f.connect("twitch");
    for (const title of ["", "  ", "x".repeat(71), "\nleading", "trailing\n", "<x>", "\ud800"]) {
      await expect(f.service.updateTitle("user-1", title)).rejects.toMatchObject({ code: "stream_title_invalid" });
    }
    for (const platforms of [["youtube"], [], ["twitch", "twitch"], "twitch"]) {
      await expect(f.service.updateTitle("user-1", "Title", platforms)).rejects.toMatchObject({ code: "stream_title_platforms_invalid" });
    }
    expect(f.calls).toHaveLength(0);
    expect((await f.service.updateTitle("user-1", "🎮".repeat(70), ["twitch"])).platforms[0].streamingReady).toBe(true);
  });
  test("unchanged title avoids writes and status returns safe connected identity", async () => {
    const f = fixture(); await f.connect("twitch");
    const result = await f.service.updateTitle("user-1", "Old Twitch", ["twitch"]);
    expect(result.platforms[0].updated).toBe(false);
    expect(f.calls.some((call) => call.init.method === "PATCH")).toBe(false);
    expect((await f.service.status("user-1")).platforms.find((row) => row.platform === "twitch"))
      .toMatchObject({ platformUserId: "42", account: "fixture_streamer", title: "Old Twitch", streamingReady: true });
  });
  test("foreign provider identity and another SC2Tools user's connection cannot be modified", async () => {
    const f = fixture(); await f.connect("kick");
    expect((await f.service.updateTitle("user-other", "Wrong", ["kick"])).platforms[0].streamingReady).toBe(false);
    f.rejectIdentity();
    expect((await f.service.updateTitle("user-1", "Wrong", ["kick"])).platforms[0].streamingReady).toBe(false);
    expect(f.calls.some((call) => call.init.method === "PATCH")).toBe(false);
  });
  test("disabled provider configuration cannot report a stored YouTube account ready", async () => {
    const f = fixture(); await f.connect("youtube");
    delete f.integrations.config.youtube;
    const status = await f.service.status("user-1");
    expect(status.platforms.find((row) => row.platform === "youtube"))
      .toMatchObject({ connected: true, streamingReady: false });
    expect(f.calls).toHaveLength(0);
  });
  test("rejected title request retains a verified connection without claiming success or replaying PATCH", async () => {
    const f = fixture(); await f.connect("kick"); f.rejectWrite();
    const result = await f.service.updateTitle("user-1", "New", ["kick"]);
    expect(result.platforms[0]).toMatchObject({ connected: true, streamingReady: true,
      connectionInvalid: false, accepted: false, updated: false, titleVerified: false, titleStatus: "rejected", title: "Old Kick" });
    expect(f.calls.filter((call) => call.init.method === "PATCH")).toHaveLength(1);
    expect(f.wait).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("fixture-private");
  });
  test("offline blank readback reports acceptance honestly and keeps Kick ready", async () => {
    const f = fixture(); await f.connect("kick"); f.kickLive(false, true);
    const result = await f.service.updateTitle("user-1", "New", ["kick"]);
    expect(result.platforms[0]).toMatchObject({ connected: true, streamingReady: true,
      connectionInvalid: false, accepted: true, updated: true, title: "New", requestedTitle: "New", observedTitle: "",
      isLive: false, titleVerified: false, titleStatus: "accepted_offline" });
    expect(result.platforms[0].reason).toContain("offline readback is empty");
    expect(f.titles.kick).toBe("New");
    expect(f.calls.filter((call) => call.init.method === "PATCH")).toHaveLength(1);
    expect(f.wait).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("fixture-private");
    const status = (await f.service.status("user-1")).platforms.find((row) => row.platform === "kick");
    expect(status).toMatchObject({ connected: true, streamingReady: true, title: "",
      isLive: false, titleVerified: false, titleStatus: "unavailable_offline" });
  });
  test("offline title is verified only if Kick actually returns the requested title", async () => {
    const f = fixture(); await f.connect("kick"); f.kickLive(false);
    const result = await f.service.updateTitle("user-1", "New", ["kick"]);
    expect(result.platforms[0]).toMatchObject({ accepted: true, titleVerified: true,
      titleStatus: "verified", title: "New", observedTitle: "New", isLive: false });
  });
  test("online stale reads can become verified with bounded GET retries and exactly one PATCH", async () => {
    const f = fixture(); await f.connect("kick"); f.delayKickReads(2);
    const result = await f.service.updateTitle("user-1", "New", ["kick"]);
    expect(result.platforms[0]).toMatchObject({ connected: true, streamingReady: true,
      accepted: true, titleVerified: true, titleStatus: "verified", title: "New" });
    expect(f.wait.mock.calls).toEqual([[350], [900]]);
    expect(f.calls.filter((call) => call.init.method === "PATCH")).toHaveLength(1);
    expect(f.calls.filter((call) => call.url.includes("/channels") && call.init.method !== "PATCH")).toHaveLength(4);
  });
  test("persistent stale readback stays pending with the observed title and a ready connection", async () => {
    const f = fixture(); await f.connect("kick"); f.ignoreWrite();
    const result = await f.service.updateTitle("user-1", "New", ["kick"]);
    expect(result.platforms[0]).toMatchObject({ connected: true, streamingReady: true,
      accepted: true, updated: true, titleVerified: false, titleStatus: "pending",
      title: "Old Kick", observedTitle: "Old Kick", requestedTitle: "New" });
    expect(f.wait).toHaveBeenCalledTimes(2);
    expect(f.calls.filter((call) => call.init.method === "PATCH")).toHaveLength(1);
  });
  test("blank title without an explicit offline flag never claims accepted_offline", async () => {
    const f = fixture(); await f.connect("kick"); f.kickLive(null, true);
    const result = await f.service.updateTitle("user-1", "New", ["kick"]);
    expect(result.platforms[0]).toMatchObject({ connected: true, streamingReady: true,
      accepted: true, titleVerified: false, titleStatus: "pending", title: "", isLive: null });
    expect(f.wait).toHaveBeenCalledTimes(2);
  });
  test("ambiguous PATCH transport failure never reports acceptance or retries the write", async () => {
    const f = fixture(); await f.connect("kick");
    const providerFetch = f.fetchImpl.getMockImplementation();
    f.fetchImpl.mockImplementation(async (url, init = {}) => {
      const response = await providerFetch(url, init);
      if (init.method === "PATCH") throw new Error("fixture-private request failed after provider application");
      return response;
    });
    const result = await f.service.updateTitle("user-1", "New", ["kick"]);
    expect(result.platforms[0]).toMatchObject({ connected: true, streamingReady: true,
      accepted: false, updated: false, titleVerified: false, titleStatus: "unverified" });
    expect(f.titles.kick).toBe("New");
    expect(f.calls.filter((call) => call.init.method === "PATCH")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("fixture-private");
  });
  test("unexpected Kick 2xx response cannot stand in for its documented 204 write receipt", async () => {
    const f = fixture(); await f.connect("kick");
    const providerFetch = f.fetchImpl.getMockImplementation();
    f.fetchImpl.mockImplementation(async (url, init = {}) => {
      const response = await providerFetch(url, init);
      return init.method === "PATCH" ? Response.json({ message: "fixture-private ambiguous receipt" }) : response;
    });
    const result = await f.service.updateTitle("user-1", "New", ["kick"]);
    expect(result.platforms[0]).toMatchObject({ connected: true, streamingReady: true,
      accepted: false, updated: false, titleVerified: false, titleStatus: "unverified" });
    expect(f.calls.filter((call) => call.init.method === "PATCH")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("fixture-private");
  });
  test("post-PATCH read transport failure stays accepted but unconfirmed without disconnecting", async () => {
    const f = fixture(); await f.connect("kick");
    const providerFetch = f.fetchImpl.getMockImplementation();
    let patched = false;
    f.fetchImpl.mockImplementation(async (url, init = {}) => {
      if (String(url).includes("/channels") && init.method !== "PATCH" && patched) throw new Error("fixture-private read timeout");
      const response = await providerFetch(url, init);
      if (init.method === "PATCH") patched = true;
      return response;
    });
    const result = await f.service.updateTitle("user-1", "New", ["kick"]);
    expect(result.platforms[0]).toMatchObject({ connected: true, streamingReady: true,
      accepted: true, updated: true, titleVerified: false, titleStatus: "pending", title: null,
      observedTitle: null, requestedTitle: "New" });
    expect(f.calls.filter((call) => call.init.method === "PATCH")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("fixture-private");
  });
  test.each([{}, { data: [] }, { data: [{ broadcaster_user_id: 42 }] },
    { data: [{ broadcaster_user_id: 42, stream_title: null }] }])(
    "incomplete channel observations preserve the verified grant and cannot authorize a write: %j", async (body) => {
      const f = fixture(); await f.connect("kick");
      const providerFetch = f.fetchImpl.getMockImplementation();
      f.fetchImpl.mockImplementation((url, init = {}) => String(url).includes("/channels")
        ? Response.json(body) : providerFetch(url, init));
      const result = await f.service.updateTitle("user-1", "New", ["kick"]);
      expect(result.platforms[0]).toMatchObject({ connected: true, streamingReady: true,
        connectionInvalid: false, accepted: false, updated: false, titleVerified: false,
        titleStatus: "unverified", title: null });
      expect(f.fetchImpl.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
      const status = (await f.service.status("user-1")).platforms.find((row) => row.platform === "kick");
      expect(status).toMatchObject({ connected: true, streamingReady: true,
        connectionInvalid: false, title: null, titleVerified: false, titleStatus: "unavailable" });
    },
  );
  test("an actually foreign channel readback invalidates control and cannot authorize a write", async () => {
    const f = fixture(); await f.connect("kick");
    const providerFetch = f.fetchImpl.getMockImplementation();
    f.fetchImpl.mockImplementation((url, init = {}) => String(url).includes("/channels")
      ? Response.json({ data: [{ broadcaster_user_id: 999, stream_title: "Foreign" }] }) : providerFetch(url, init));
    const result = await f.service.updateTitle("user-1", "New", ["kick"]);
    expect(result.platforms[0]).toMatchObject({ connected: false, streamingReady: false,
      connectionInvalid: true, accepted: false, updated: false, title: null });
    expect(f.fetchImpl.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });
  test("lease replacement during delayed verification cannot report the title accepted or ready", async () => {
    const f = fixture(); await f.connect("kick"); f.ignoreWrite();
    f.wait.mockImplementation(async () => { f.db.rows.get("user-1:kick").connectionRevision = "replacement"; });
    const result = await f.service.updateTitle("user-1", "New", ["kick"]);
    expect(result.platforms[0]).toMatchObject({ connected: false, streamingReady: false,
      connectionInvalid: false, accepted: false, updated: false, titleVerified: false, title: null });
    expect(f.calls.filter((call) => call.init.method === "PATCH")).toHaveLength(1);
    expect(f.wait).toHaveBeenCalledTimes(1);
  });
  test("grant callback executes once even for 401 and does not replay writes", async () => {
    const f = fixture(); await f.connect("kick");
    const callback = jest.fn(async () => { throw Object.assign(new Error("expired"), { status: 401 }); });
    await expect(f.integrations.withStreamingGrant("user-1", "kick", callback)).rejects.toMatchObject({ status: 401 });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(f.calls.some((call) => call.url.endsWith("/oauth/token"))).toBe(false);
  });
  test("database lease prevents independent API workers and existing health operations from racing refresh", async () => {
    const first = fixture(); await first.connect("kick");
    const second = fixture(first.db);
    let release; const blocked = new Promise((resolve) => { release = resolve; });
    let entered; const ready = new Promise((resolve) => { entered = resolve; });
    const active = first.integrations.withStreamingGrant("user-1", "kick", async () => { entered(); await blocked; return "ok"; });
    await ready;
    const callback = jest.fn();
    await expect(second.integrations.withStreamingGrant("user-1", "kick", callback)).rejects.toMatchObject({ code: "streaming_account_busy" });
    await expect(second.integrations._withConnectionLock("user-1", "kick", callback)).rejects.toMatchObject({ code: "streaming_account_busy" });
    expect(callback).not.toHaveBeenCalled();
    expect((await second.service.updateTitle("user-1", "Title", ["kick"])).platforms[0])
      .toMatchObject({ streamingReady: false, connectionInvalid: false, accepted: false, titleVerified: false });
    release(); await expect(active).resolves.toBe("ok");
    expect(second.calls).toHaveLength(0);
  });
  test("missing atomic lease primitive disables stream control, never falls back to process-only lock", async () => {
    const f = fixture(); await f.connect("kick");
    delete f.db.platformConnections.findOneAndUpdate;
    await expect(f.integrations.withStreamingGrant("user-1", "kick", jest.fn())).rejects.toMatchObject({ code: "streaming_coordination_unavailable" });
    expect(f.calls).toHaveLength(0);
    expect((await f.service.status("user-1")).platforms.every((row) => !row.streamingReady)).toBe(true);
  });
  test("expired grant rotates tokens inside lease before callback, persisted encrypted", async () => {
    const f = fixture(); await f.connect("kick", {}, undefined, new Date(NOW));
    await f.integrations.withStreamingGrant("user-1", "kick", async (grant) => {
      expect(grant.accessToken).toBe("fixture-rotated-access");
      await grant.assertCurrent();
    });
    expect(f.calls.filter((call) => call.url.endsWith("/oauth/token"))).toHaveLength(1);
    expect((await f.integrations.vault.getConnection("user-1", "kick")).refreshToken).toBe("fixture-rotated-refresh");
    expect(JSON.stringify(f.db.rows.get("user-1:kick"))).not.toContain("fixture-rotated");
  });
  test("Kick refresh stores introspected scopes when the token response omits them", async () => {
    const f = fixture(); await f.connect("kick", {}, undefined, new Date(NOW));
    f.integrations.oauth = { ...oauth, refreshKickToken: async () => ({
      accessToken: "fixture-rotated-access", refreshToken: "fixture-rotated-refresh",
      expiresAt: new Date(NOW + 4_000_000), scopes: [],
    }) };
    await expect(f.integrations.withStreamingGrant("user-1", "kick", async () => "verified"))
      .resolves.toBe("verified");
    const row = await f.integrations.vault.getConnection("user-1", "kick");
    expect(row.scopes).toEqual(oauth.STREAMING_SCOPES.kick);
    expect(row.accessToken).toBe("fixture-rotated-access");
  });
  test("Kick refresh rejects a reduced introspected grant before token storage or channel work", async () => {
    const f = fixture(); await f.connect("kick", {}, undefined, new Date(NOW));
    const providerFetch = f.fetchImpl.getMockImplementation();
    f.fetchImpl.mockImplementation((url, init) => String(url).includes("oauth/token/introspect")
      ? Response.json({ data: { active: true, token_type: "user", client_id: "own-kick", scope: oauth.KICK_SCOPES.join(" ") } })
      : providerFetch(url, init));
    const callback = jest.fn();
    await expect(f.integrations.withStreamingGrant("user-1", "kick", callback))
      .rejects.toMatchObject({ code: "streaming_scopes_missing" });
    expect(callback).not.toHaveBeenCalled();
    expect((await f.integrations.vault.getConnection("user-1", "kick")).accessToken).toBe("fixture-access");
    expect(f.calls.some((call) => call.url.includes("/channels"))).toBe(false);
  });
  test.each([true, false])("Kick background health preserves explicit consent on refresh: %j", async (streamingConsent) => {
    const f = fixture();
    await f.connect("kick", { streamingConsent }, streamingConsent ? oauth.STREAMING_SCOPES.kick : oauth.KICK_SCOPES, new Date(NOW));
    f.integrations.oauth = { ...oauth,
      refreshKickToken: async () => ({ accessToken: "fixture-health-access", refreshToken: "fixture-health-refresh",
        expiresAt: new Date(NOW + 4_000_000), scopes: [] }),
      subscribeKickEvents: jest.fn(async () => ({ existing: [], created: [] })),
    };
    await expect(f.integrations.reconcileProviderHealthOnce()).resolves.toEqual({ checked: 1 });
    const row = await f.integrations.vault.getConnection("user-1", "kick");
    expect(row.accessToken).toBe("fixture-health-access");
    expect(row.scopes).toEqual(streamingConsent ? oauth.STREAMING_SCOPES.kick : oauth.KICK_SCOPES);
    expect(row.metadata.streamingConsent).toBe(streamingConsent);
    expect(f.fetchImpl.mock.calls.some(([url]) => String(url).includes("token/introspect"))).toBe(streamingConsent);
  });
  test("unleased/stale legacy worker cannot replace a streaming grant token", async () => {
    const f = fixture(); await f.connect("kick");
    const row = await f.integrations.vault.getConnection("user-1", "kick");
    expect(await f.integrations.vault.updateTokens("user-1", "kick", { accessToken: "unleased-token" }, row.connectionRevision)).toBe(false);
    expect((await f.integrations.vault.getConnection("user-1", "kick")).accessToken).toBe("fixture-access");
  });
  test("bounded grant blocks external hosts and detects revision replacement before another provider request", async () => {
    const f = fixture(); await f.connect("kick");
    await f.integrations.withStreamingGrant("user-1", "kick", async (grant) => {
      await expect(grant.boundedFetch("https://evil.invalid/private", { headers: { Authorization: "Bearer fixture-secret" } })).rejects.toMatchObject({ code: "streaming_endpoint_invalid" });
      f.db.rows.get("user-1:kick").connectionRevision = "different-revision";
      await expect(grant.boundedFetch("https://api.kick.com/public/v1/channels")).rejects.toMatchObject({ code: "streaming_connection_changed" });
    }).catch((error) => expect(error.code).toBe("streaming_connection_changed"));
    expect(f.calls.some((call) => call.url.includes("evil.invalid"))).toBe(false);
  });
});

describe("explicit streaming OAuth purpose", () => {
  function kickGrant(f, data, scopes = []) {
    const providerFetch = f.fetchImpl.getMockImplementation();
    f.fetchImpl.mockImplementation((url, init) => String(url).includes("oauth/token/introspect")
      ? Response.json({ data }) : providerFetch(url, init));
    f.integrations.oauth = { ...oauth,
      exchangeKickCode: async () => ({ accessToken: "fixture-new-access", refreshToken: "fixture-new-refresh",
        expiresAt: new Date(NOW + 4_000_000), scopes }),
      subscribeKickEvents: jest.fn(async () => ({ existing: [], created: [] })),
    };
  }
  test.each([[], oauth.KICK_SCOPES, oauth.STREAMING_SCOPES.kick].map((scopes) => [scopes]))(
    "Kick consent uses the verified introspected grant rather than exchange scopes %j", async (scopes) => {
      const f = fixture();
      kickGrant(f, { active: true, token_type: "user", client_id: "own-kick",
        scope: oauth.STREAMING_SCOPES.kick.join(" ") }, scopes);
      const begun = await f.integrations.begin("user-1", "kick", { purpose: "streaming" });
      await expect(f.integrations.complete("kick", { code: "fixture-code",
        state: new URL(begun.authorizeUrl).searchParams.get("state") }))
        .resolves.toEqual({ userId: "user-1", platform: "kick" });
      const row = await f.integrations.vault.getConnection("user-1", "kick");
      expect(row.scopes).toEqual(oauth.STREAMING_SCOPES.kick);
      expect(row.metadata.streamingConsent).toBe(true);
      expect((await f.service.status("user-1")).platforms.find((row) => row.platform === "kick").streamingReady).toBe(true);
    },
  );
  test.each([
    [{ active: true, token_type: "user", client_id: "own-kick", scope: oauth.KICK_SCOPES.join(" ") }, "streaming_scopes_missing"],
    [{ active: true, token_type: "user", client_id: "other-client", scope: oauth.STREAMING_SCOPES.kick.join(" ") }, "streaming_client_mismatch"],
    [{ active: false, token_type: "user", client_id: "own-kick", scope: oauth.STREAMING_SCOPES.kick.join(" ") }, "kick_user_authorization_required"],
    [{ active: true, token_type: "app", client_id: "own-kick", scope: oauth.STREAMING_SCOPES.kick.join(" ") }, "kick_user_authorization_required"],
    [{ active: true, token_type: "user", client_id: "own-kick" }, "streaming_scopes_missing"],
    [null, "kick_user_authorization_required"],
  ])("a rejected Kick introspection preserves the existing alerts connection %j", async (data, code) => {
    const f = fixture();
    await f.connect("kick", { streamingConsent: false }, oauth.KICK_SCOPES);
    const original = JSON.stringify(f.db.rows.get("user-1:kick"));
    kickGrant(f, data, oauth.STREAMING_SCOPES.kick);
    const begun = await f.integrations.begin("user-1", "kick", { purpose: "streaming" });
    await expect(f.integrations.complete("kick", { code: "fixture-code",
      state: new URL(begun.authorizeUrl).searchParams.get("state") })).rejects.toMatchObject({ code });
    expect(JSON.stringify(f.db.rows.get("user-1:kick"))).toBe(original);
    expect(f.integrations.oauth.subscribeKickEvents).not.toHaveBeenCalled();
    expect(f.calls.some((call) => call.url.includes("revoke"))).toBe(false);
  });
  test("default scopes stay unchanged while streaming requests the opt-in additions", async () => {
    const f = fixture();
    for (const platform of ["twitch", "kick", "youtube"]) {
      const standard = await f.integrations.begin("user-1", platform);
      const optIn = await f.integrations.begin("user-1", platform, { purpose: "streaming" });
      const normalScopes = new URL(standard.authorizeUrl).searchParams.get("scope").split(" ");
      const streamingScopes = new URL(optIn.authorizeUrl).searchParams.get("scope").split(" ");
      expect(normalScopes).toEqual(oauth.scopesForPurpose(platform, "alerts"));
      expect(streamingScopes).toEqual(oauth.STREAMING_SCOPES[platform]);
      if (platform === "youtube") {
        expect(normalScopes).toEqual(["https://www.googleapis.com/auth/youtube.readonly"]);
        expect(streamingScopes).toEqual(["https://www.googleapis.com/auth/youtube.force-ssl"]);
      }
      const pending = await f.integrations.vault.consumeOauthState(new URL(optIn.authorizeUrl).searchParams.get("state"), platform);
      expect(pending.purpose).toBe("streaming");
      expect(pending.requiredScopes).toEqual(oauth.STREAMING_SCOPES[platform]);
      expect(pending.userId).toBe("user-1");
    }
    await expect(f.integrations.begin("user-1", "twitch", { purpose: "silent-upgrade" })).rejects.toMatchObject({ code: "oauth_purpose_invalid" });
  });
  test("a missing write scope cannot install an apparently enabled streaming connection", async () => {
    const f = fixture();
    f.integrations.oauth = { ...oauth, exchangeYoutubeCode: async () => ({ accessToken: "fixture-access", scopes: oauth.YOUTUBE_SCOPES }),
      getYoutubeCurrentChannel: async () => ({ userId: "fixture-channel" }) };
    const begun = await f.integrations.begin("user-1", "youtube", { purpose: "streaming" });
    f.integrations._installConnection = jest.fn();
    await expect(f.integrations.complete("youtube", { code: "fixture-code", state: new URL(begun.authorizeUrl).searchParams.get("state") })).rejects.toMatchObject({ code: "streaming_scopes_missing" });
    expect(f.integrations._installConnection).not.toHaveBeenCalled();
  });
  test("force-ssl-only YouTube consent installs stream controls and preserves existing catalog reads", async () => {
    const f = fixture();
    const listPublicYoutubeBroadcasts = jest.fn(async () => []);
    f.integrations.oauth = { ...oauth,
      exchangeYoutubeCode: async () => ({ accessToken: "fixture-access", refreshToken: "fixture-refresh",
        expiresAt: new Date(NOW + 4_000_000), scopes: ["https://www.googleapis.com/auth/youtube.force-ssl"] }),
      getYoutubeCurrentChannel: async () => ({ userId: "42", userName: "fixture_streamer" }),
      listYoutubeRecentSubscribers: async () => [], listPublicYoutubeBroadcasts };
    const begun = await f.integrations.begin("user-1", "youtube", { purpose: "streaming" });
    await expect(f.integrations.complete("youtube", { code: "fixture-code",
      state: new URL(begun.authorizeUrl).searchParams.get("state") })).resolves.toEqual({ userId: "user-1", platform: "youtube" });
    const stored = await f.integrations.vault.getConnection("user-1", "youtube");
    expect(stored.scopes).toEqual(["https://www.googleapis.com/auth/youtube.force-ssl"]);
    expect(stored.metadata.streamingConsent).toBe(true);
    await expect(f.integrations.withStreamingGrant("user-1", "youtube", async (grant) => grant.platformUserId)).resolves.toBe("42");
    await expect(f.integrations.resolvePublicYoutubeBroadcasts("user-1", ["abcdefghijk"])).resolves.toEqual([]);
    expect(listPublicYoutubeBroadcasts).toHaveBeenCalledTimes(1);
    expect((await f.service.status("user-1")).platforms.find((row) => row.platform === "youtube").streamingReady).toBe(true);
    expect(f.calls).toHaveLength(0);
  });
});

describe("paired agent routes", () => {
  function appFor(f, source = "device") {
    const app = express(); app.use(express.json());
    const auth = (req, _res, next) => { req.auth = { userId: "user-1", source }; next(); };
    app.use("/v1", buildAgentStreamingRouter({ auth, integrations: f.integrations, streamingTitles: f.service }));
    app.use("/v1", buildPlatformIntegrationsRouter({ auth, integrations: f.integrations }));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: { code: error.code, message: error.message } }));
    return app;
  }
  test("device can read status and explicitly start a user-bound streaming consent flow", async () => {
    const f = fixture(); await f.connect("twitch"); const app = appFor(f);
    const response = await request(app).get("/v1/agent/streaming/status").expect(200);
    expect(response.body.platforms[0]).toMatchObject({ platformUserId: "42", account: "fixture_streamer" });
    const connect = await request(app).post("/v1/agent/streaming/youtube/connect").send({}).expect(200);
    expect(new URL(connect.body.authorizeUrl).searchParams.get("scope")).toContain("youtube.force-ssl");
    await request(app).post("/v1/me/integrations/youtube/connect").send({ purpose: "streaming" }).expect(403);
  });
  test("agent cannot supply another user/channel identity or credentials", async () => {
    const f = fixture(); await f.connect("twitch"); const app = appFor(f);
    for (const field of ["userId", "channelId", "accessToken"]) {
      await request(app).post("/v1/agent/streaming/title").send({ title: "New", [field]: "other-user-or-secret" }).expect(400);
      await request(app).post("/v1/agent/streaming/twitch/connect").send({ [field]: "other-user-or-secret" }).expect(400);
    }
    expect(f.calls).toHaveLength(0);
    const changed = await request(app).post("/v1/agent/streaming/title").send({ title: "New", platforms: ["twitch"] }).expect(200);
    expect(changed.body.platforms[0].title).toBe("New");
    expect(JSON.stringify(changed.body)).not.toContain("fixture-access");
  });
  test("Clerk website preserves default alerts but exposes explicit streaming purpose", async () => {
    const f = fixture(); const app = appFor(f, "clerk");
    const ordinary = await request(app).post("/v1/me/integrations/twitch/connect").send({}).expect(200);
    const explicit = await request(app).post("/v1/me/integrations/twitch/connect").send({ purpose: "streaming" }).expect(200);
    expect(new URL(ordinary.body.authorizeUrl).searchParams.get("scope")).not.toContain("channel:manage:broadcast");
    expect(new URL(explicit.body.authorizeUrl).searchParams.get("scope")).toContain("channel:manage:broadcast");
  });
});
