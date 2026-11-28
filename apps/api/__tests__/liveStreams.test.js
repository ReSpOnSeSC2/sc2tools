// @ts-nocheck
"use strict";

/**
 * Live Streams (services/liveStreams.js, services/liveStreamProviders.js and
 * routes/liveStreams.js) against a fake provider fetch: request shapes,
 * normalizing, the one-minute cache, stale and error reporting, token
 * retry, and the public route contract.
 */

const express = require("express");
const request = require("supertest");
const { LiveStreamsService, CACHE_TTL_MS, STALE_LIMIT_MS } = require("../src/services/liveStreams");
const { normalizeLanguage } = require("../src/services/liveStreamProviders");
const { buildLiveStreamsRouter } = require("../src/routes/liveStreams");

const CREDENTIALS = { clientId: "id", clientSecret: "secret", redirectUri: "https://x.test/cb" };

const json = (body, status = 200) => ({
  ok: status < 400,
  status,
  headers: new Headers({ "content-type": "application/json" }),
  text: async () => JSON.stringify(body),
  json: async () => body,
});

const twitchRow = (n, viewers, extra = {}) => ({
  id: `t${n}`, user_login: `chan${n}`, user_name: `Chan${n}`, title: `Game ${n}`,
  language: "en", viewer_count: viewers, started_at: "2026-11-27T10:00:00Z", ...extra,
});
const kickRow = (n, viewers, extra = {}) => ({
  id: `k${n}`, broadcaster_user: { username: `Kicker${n}` }, channel: { slug: `kicker${n}` },
  title: `Kick ${n}`, language_code: "pt-BR", viewer_count: viewers, started_at: "2026-11-27T09:00:00Z", ...extra,
});

/** A provider fake: handlers keyed by host+path, every call recorded. */
function makeFetch(handlers) {
  const calls = [];
  const fetchImpl = jest.fn(async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init });
    const handler = handlers[parsed.origin + parsed.pathname];
    if (!handler) throw new Error(`unexpected request ${url}`);
    return handler(parsed, init);
  });
  return { fetchImpl, calls };
}

const twitchToken = () => json({ access_token: "twitch-app", expires_in: 5000000 });
const kickToken = () => json({ access_token: "kick-app", expires_in: 7200 });
const TWITCH = "https://api.twitch.tv/helix/streams";
const KICK_LIVE = "https://api.kick.com/public/v2/livestreams";
const KICK_CATEGORIES = "https://api.kick.com/public/v2/categories";
const TWITCH_TOKEN = "https://id.twitch.tv/oauth2/token";
const KICK_TOKEN = "https://id.kick.com/oauth/token";

function bothProviders(overrides = {}) {
  return makeFetch({
    [TWITCH_TOKEN]: twitchToken,
    [KICK_TOKEN]: kickToken,
    [TWITCH]: () => json({ data: [twitchRow(1, 40), twitchRow(2, 900)], pagination: {} }),
    [KICK_CATEGORIES]: () => json({ data: [{ id: 7, name: "StarCraft" }, { id: 8, name: "StarCraft II" }] }),
    [KICK_LIVE]: () => json({ data: [kickRow(1, 250)], pagination: {} }),
    ...overrides,
  });
}

function service(fetchImpl, clock, config = { twitch: CREDENTIALS, kick: CREDENTIALS }) {
  return new LiveStreamsService({ config, fetchImpl, now: () => clock.t });
}

/** Waits for the refresh an expired list started behind its caller. */
async function refreshed(live) {
  await live.pending;
  return live.list();
}

describe("LiveStreamsService", () => {
  let clock;
  beforeEach(() => { clock = { t: Date.parse("2026-11-27T12:00:00Z") }; });

  it("merges both platforms most viewers first with normalized fields", async () => {
    const { fetchImpl } = bothProviders();
    const snapshot = await service(fetchImpl, clock).list();
    expect(snapshot.platforms).toEqual({ twitch: "ok", kick: "ok" });
    expect(snapshot.fetchedAt).toBe("2026-11-27T12:00:00.000Z");
    expect(snapshot.streams.map(s => s.id)).toEqual(["twitch:t2", "kick:k1", "twitch:t1"]);
    expect(snapshot.streams[1]).toEqual({
      id: "kick:k1", platform: "kick", channel: "Kicker1", title: "Kick 1", language: "pt",
      viewers: 250, startedAt: "2026-11-27T09:00:00Z", url: "https://kick.com/kicker1",
    });
    expect(snapshot.streams[0].url).toBe("https://www.twitch.tv/chan2");
  });

  it("asks Twitch for live StarCraft II streams and Kick for that category's id", async () => {
    const { fetchImpl, calls } = bothProviders();
    await service(fetchImpl, clock).list();
    const twitch = calls.find(c => c.url.href.startsWith(TWITCH));
    expect(twitch.url.searchParams.get("game_id")).toBe("490422");
    expect(twitch.url.searchParams.get("type")).toBe("live");
    expect(twitch.init.headers).toEqual({ "Client-Id": "id", Authorization: "Bearer twitch-app" });
    const kick = calls.find(c => c.url.href.startsWith(KICK_LIVE));
    expect(kick.url.searchParams.get("category_id")).toBe("8");
    expect(kick.init.headers.Authorization).toBe("Bearer kick-app");
  });

  it("follows pagination cursors and stops at three pages", async () => {
    const { fetchImpl, calls } = bothProviders({
      [TWITCH]: (url) => {
        const page = Number(url.searchParams.get("after") || 0) + 1;
        return json({ data: [twitchRow(page, page)], pagination: { cursor: String(page) } });
      },
    });
    const snapshot = await service(fetchImpl, clock, { twitch: CREDENTIALS }).list();
    expect(calls.filter(c => c.url.href.startsWith(TWITCH))).toHaveLength(3);
    expect(snapshot.streams).toHaveLength(3);
  });

  it("drops rows without a usable channel and cleans titles", async () => {
    const { fetchImpl } = bothProviders({
      [TWITCH]: () => json({ data: [twitchRow(1, 5, { user_login: "bad/login" }), twitchRow(2, 5, { title: "  A \n  B  ", language: "" })] }),
    });
    const { streams } = await service(fetchImpl, clock, { twitch: CREDENTIALS }).list();
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ title: "A B", language: "other" });
  });

  it("serves one cached list for a minute and shares one in-flight fetch", async () => {
    const { fetchImpl, calls } = bothProviders();
    const live = service(fetchImpl, clock);
    await Promise.all([live.list(), live.list(), live.list()]);
    const after = calls.length;
    clock.t += CACHE_TTL_MS - 1;
    await live.list();
    expect(calls).toHaveLength(after);
    clock.t += 2;
    await live.list();
    await live.pending;
    expect(calls.length).toBeGreaterThan(after);
    expect(calls.filter(c => c.url.href.startsWith(TWITCH_TOKEN))).toHaveLength(1);
    expect(calls.filter(c => c.url.href.startsWith(KICK_CATEGORIES))).toHaveLength(1);
  });

  it("keeps a failed platform's last list as stale, then reports an error", async () => {
    let kickDown = false;
    const { fetchImpl } = bothProviders({
      [KICK_LIVE]: () => (kickDown ? json({ message: "boom" }, 500) : json({ data: [kickRow(1, 250)] })),
    });
    const live = service(fetchImpl, clock);
    await live.list();
    kickDown = true;
    clock.t += CACHE_TTL_MS + 1;
    await live.list();
    const stale = await refreshed(live);
    expect(stale.platforms).toEqual({ twitch: "ok", kick: "stale" });
    expect(stale.streams.some(s => s.platform === "kick")).toBe(true);
    clock.t += STALE_LIMIT_MS;
    await live.list();
    const failed = await refreshed(live);
    expect(failed.platforms).toEqual({ twitch: "ok", kick: "error" });
    expect(failed.streams.some(s => s.platform === "kick")).toBe(false);
  });

  it("serves the expired list at once while a hanging provider refreshes behind it", async () => {
    let kickHangs = false;
    const { fetchImpl } = bothProviders({
      [KICK_LIVE]: () => (kickHangs ? new Promise(() => {}) : json({ data: [kickRow(1, 250)] })),
    });
    const live = new LiveStreamsService({
      config: { twitch: CREDENTIALS, kick: CREDENTIALS }, fetchImpl, now: () => clock.t, platformDeadlineMs: 20,
    });
    const first = await live.list();
    kickHangs = true;
    clock.t += CACHE_TTL_MS + 1;
    expect(await live.list()).toBe(first);
    const refreshedList = await refreshed(live);
    expect(refreshedList).not.toBe(first);
    expect(refreshedList.platforms).toEqual({ twitch: "ok", kick: "stale" });
    expect(refreshedList.streams.some(s => s.platform === "kick")).toBe(true);
  });

  it("cuts off a hanging platform on the first load so the other one still answers", async () => {
    const { fetchImpl } = bothProviders({ [KICK_LIVE]: () => new Promise(() => {}) });
    const live = new LiveStreamsService({
      config: { twitch: CREDENTIALS, kick: CREDENTIALS }, fetchImpl, now: () => clock.t, platformDeadlineMs: 20,
    });
    const snapshot = await live.list();
    expect(snapshot.platforms).toEqual({ twitch: "ok", kick: "error" });
    expect(snapshot.streams.map(s => s.platform)).toEqual(["twitch", "twitch"]);
  });

  it("keeps one copy of a stream that Twitch repeats across pages", async () => {
    const { fetchImpl } = bothProviders({
      [TWITCH]: (url) => (url.searchParams.get("after")
        ? json({ data: [twitchRow(2, 800), twitchRow(3, 5)], pagination: {} })
        : json({ data: [twitchRow(1, 900), twitchRow(2, 850)], pagination: { cursor: "c" } })),
    });
    const { streams } = await service(fetchImpl, clock, { twitch: CREDENTIALS }).list();
    expect(streams.map(s => s.id)).toEqual(["twitch:t1", "twitch:t2", "twitch:t3"]);
  });

  it("marks a platform without credentials off and never calls it", async () => {
    const { fetchImpl, calls } = bothProviders();
    const snapshot = await service(fetchImpl, clock, { twitch: CREDENTIALS, kick: null }).list();
    expect(snapshot.platforms).toEqual({ twitch: "ok", kick: "off" });
    expect(calls.some(c => c.url.host.includes("kick"))).toBe(false);
  });

  it("fetches a fresh app token once when a provider rejects the cached one", async () => {
    let issued = 0;
    const { fetchImpl, calls } = bothProviders({
      [TWITCH_TOKEN]: () => json({ access_token: `token-${(issued += 1)}`, expires_in: 5000000 }),
      [TWITCH]: (_url, init) => (init.headers.Authorization === "Bearer token-1"
        ? json({ message: "Invalid OAuth token" }, 401)
        : json({ data: [twitchRow(1, 3)] })),
    });
    const snapshot = await service(fetchImpl, clock, { twitch: CREDENTIALS }).list();
    expect(snapshot.platforms.twitch).toBe("ok");
    expect(calls.filter(c => c.url.href.startsWith(TWITCH_TOKEN))).toHaveLength(2);
  });

  it("reports an error when Kick has no StarCraft II category", async () => {
    const { fetchImpl } = bothProviders({ [KICK_CATEGORIES]: () => json({ data: [{ id: 7, name: "StarCraft" }] }) });
    const snapshot = await service(fetchImpl, clock, { kick: CREDENTIALS }).list();
    expect(snapshot.platforms.kick).toBe("error");
  });
});

describe("normalizeLanguage", () => {
  it("keeps the lower-case primary subtag and falls back to other", () => {
    expect(normalizeLanguage("EN-us")).toBe("en");
    expect(normalizeLanguage("zh_TW")).toBe("zh");
    expect(normalizeLanguage("")).toBe("other");
    expect(normalizeLanguage("other")).toBe("other");
    expect(normalizeLanguage(undefined)).toBe("other");
  });
});

describe("GET /v1/live-streams", () => {
  const appFor = (liveStreams) => {
    const app = express();
    app.use("/v1", buildLiveStreamsRouter({ liveStreams }));
    return app;
  };
  const snapshot = (platforms, streams = []) => ({ streams, platforms, fetchedAt: "2026-11-27T12:00:00.000Z" });

  it("is public, returns the snapshot and lets the browser cache it briefly", async () => {
    const body = snapshot({ twitch: "ok", kick: "off" }, [{ id: "twitch:1" }]);
    const res = await request(appFor({ list: async () => body })).get("/v1/live-streams");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(body);
    expect(res.headers["cache-control"]).toBe("public, max-age=30, stale-while-revalidate=30");
  });

  it("answers 503 when every configured platform failed", async () => {
    const list = async () => snapshot({ twitch: "error", kick: "error" });
    const res = await request(appFor({ list })).get("/v1/live-streams");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("live_streams_unavailable");
    expect(res.headers["cache-control"]).toBeUndefined();
  });

  it("answers 503 when one platform failed and the other is switched off", async () => {
    const list = async () => snapshot({ twitch: "error", kick: "off" });
    expect((await request(appFor({ list })).get("/v1/live-streams")).status).toBe(503);
  });

  it("limits how often one client can read the list", async () => {
    const app = express();
    app.use("/v1", buildLiveStreamsRouter({ liveStreams: { list: async () => snapshot({ twitch: "ok", kick: "off" }) }, rateLimitPerMinute: 2 }));
    expect((await request(app).get("/v1/live-streams")).status).toBe(200);
    expect((await request(app).get("/v1/live-streams")).status).toBe(200);
    expect((await request(app).get("/v1/live-streams")).status).toBe(429);
  });

  it("still answers 200 when one platform failed but another has a list", async () => {
    const list = async () => snapshot({ twitch: "ok", kick: "error" });
    expect((await request(appFor({ list })).get("/v1/live-streams")).status).toBe(200);
  });

  it("answers 200 with nothing live when no platform is configured", async () => {
    const list = async () => snapshot({ twitch: "off", kick: "off" });
    const res = await request(appFor({ list })).get("/v1/live-streams");
    expect(res.status).toBe(200);
    expect(res.body.streams).toEqual([]);
  });

  it("refuses to build without a service", () => {
    expect(() => buildLiveStreamsRouter({})).toThrow(/liveStreams/);
  });
});
