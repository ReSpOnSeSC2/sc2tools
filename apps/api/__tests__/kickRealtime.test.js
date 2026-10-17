// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { buildMultichatRouter } = require("../src/routes/multichat");
const {
  KickRealtimeService,
  parseKickConnection,
  CACHE_TTL_MS,
  FETCH_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
} = require("../src/services/kickRealtime");

const PUBLIC_KEY = "34bf7a0ff419a2a775b9";
const descriptor = (key = PUBLIC_KEY, cluster = "us2") => ({
  data: { mode: "websocket", connections: [
    { provider: "pusher", credentials: { app_key: key, cluster } },
  ] },
});
const jsonResponse = (body) => new Response(JSON.stringify(body), {
  headers: { "Content-Type": "application/json" },
});

describe("Kick realtime discovery", () => {
  test("requests the supported public provider and returns only safe socket coordinates", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ ...descriptor(), ignored: "never relayed" }));
    const service = new KickRealtimeService({ fetchImpl });
    const out = await service.getConnection();
    expect(out).toEqual({
      provider: "pusher",
      url: `wss://ws-us2.pusher.com/app/${PUBLIC_KEY}?protocol=7&client=js&version=8.4.0-rc2&flash=false`,
    });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://web.kick.com/api/v1/realtime/connection");
    expect(options).toMatchObject({ method: "POST", redirect: "error" });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      client: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), type: "web" },
      capabilities: { accepted_providers: [{ provider: "pusher" }] },
    });
  });

  test.each([
    { data: { mode: "polling", connections: descriptor().data.connections } },
    { data: { mode: "websocket", connections: [{ provider: "centrifugo", credentials: { url: "wss://evil.test/" } }] } },
    descriptor(PUBLIC_KEY, "us2.pusher.com@evil.test"),
    descriptor(`${PUBLIC_KEY}/../../../`, "us2"),
    descriptor(PUBLIC_KEY, "us2:443"),
    {},
  ])("rejects unsupported or injected discovery coordinates %#", (body) => {
    expect(() => parseKickConnection(body)).toThrow("supported chat connection");
  });
});

describe("Kick realtime lookup lifecycle", () => {
  test("shares one lookup and refreshes its single cache entry after the TTL", async () => {
    let release;
    let now = 100;
    const fetchImpl = jest.fn(() => new Promise((resolve) => { release = resolve; }));
    const service = new KickRealtimeService({ fetchImpl, now: () => now });
    const first = service.getConnection();
    const second = service.getConnection();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release(jsonResponse(descriptor()));
    const [one, two] = await Promise.all([first, second]);
    expect(one).toEqual(two);
    two.url = "wss://tampered.test";
    expect(await service.getConnection()).toEqual(one);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += CACHE_TTL_MS;
    const refresh = service.getConnection();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    release(jsonResponse(descriptor("1234567890abcdefghij", "eu")));
    expect((await refresh).url).toContain("ws-eu.pusher.com/app/1234567890abcdefghij");
  });

  test("does not cache failures or expose an upstream error body", async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(new Response("private upstream details", { status: 403 }))
      .mockResolvedValueOnce(jsonResponse(descriptor()));
    const service = new KickRealtimeService({ fetchImpl });
    await expect(service.getConnection()).rejects.toMatchObject({
      code: "kick_realtime_unavailable",
      message: "Kick chat connection lookup failed; retrying",
    });
    await expect(service.getConnection()).resolves.toMatchObject({ provider: "pusher" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("bounds decoded response bytes", async () => {
    const service = new KickRealtimeService({
      fetchImpl: async () => new Response(" ".repeat(MAX_RESPONSE_BYTES + 1)),
    });
    await expect(service.getConnection()).rejects.toThrow("too large");
  });

  test("passes the timeout signal through and clears failed in-flight work", async () => {
    const controller = new AbortController();
    const timeout = jest.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const fetchImpl = jest.fn((_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }));
      const service = new KickRealtimeService({ fetchImpl });
      const pending = service.getConnection();
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "kick_realtime_unavailable" });
      expect(timeout).toHaveBeenCalledWith(FETCH_TIMEOUT_MS);
      expect(service.inFlight).toBeNull();
    } finally {
      timeout.mockRestore();
    }
  });
});

function appFor(prefs = { kick: { enabled: true, chatroomId: 8161542 } }) {
  const fetchImpl = jest.fn(async () => jsonResponse(descriptor()));
  const getPreferences = jest.fn(async () => prefs);
  const app = express();
  app.use("/v1", buildMultichatRouter({
    overlayTokens: { resolve: async (token) => token === "valid" ? { userId: "owner" } : null },
    users: { getPreferences },
    fetchImpl,
  }));
  return { app, fetchImpl, getPreferences };
}

describe("Kick connection relay", () => {
  test("rejects invalid overlay tokens before preferences or upstream traffic", async () => {
    const { app, fetchImpl, getPreferences } = appFor();
    const response = await request(app).get("/v1/multichat/invalid/kick/connection");
    expect(response.status).toBe(401);
    expect(getPreferences).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    {},
    { kick: { enabled: false, chatroomId: 8161542 } },
    { kick: { enabled: true, chatroomId: -1 } },
    { kick: { enabled: true, chatroomId: "8161542" } },
  ])("requires a configured Kick room from saved preferences %#", async (prefs) => {
    const { app, fetchImpl } = appFor(prefs);
    const response = await request(app).get("/v1/multichat/valid/kick/connection?chatroomId=8161542&enabled=true");
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("kick_not_configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("returns discovered public transport without trusting caller URLs or slugs", async () => {
    const { app, fetchImpl, getPreferences } = appFor();
    const response = await request(app).get("/v1/multichat/valid/kick/connection?url=https://evil.test&slug=attacker");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toEqual(parseKickConnection(descriptor()));
    expect(getPreferences).toHaveBeenCalledWith("owner", "multichat");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://web.kick.com/api/v1/realtime/connection");
  });

  test("reports upstream failures as structured retryable lookup errors", async () => {
    const { app, fetchImpl } = appFor();
    fetchImpl.mockRejectedValue(new Error("secret upstream context"));
    const response = await request(app).get("/v1/multichat/valid/kick/connection");
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: {
      code: "kick_realtime_unavailable",
      message: "Kick chat connection lookup failed; retrying",
    } });
  });
});
