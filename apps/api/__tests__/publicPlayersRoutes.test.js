// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { buildPublicPlayersRouter } = require("../src/routes/publicPlayers");
const { buildPublicProfileRouter } = require("../src/routes/publicProfile");

function fixture(limit = 60) {
  const players = { get: jest.fn(async slug => slug.startsWith("public") ? { profile: { handle: slug, displayName: "Public player" }, handle: slug, displayName: "Public player", archiveOnly: false } : null),
    sitemap: jest.fn(async () => ({ items: [] })) };
  const preferences = { get: jest.fn(async () => ({ enabled: false, slug: null })), set: jest.fn(async (_owner, body) => body), availability: jest.fn(async (_owner, slug) => ({ slug, available: true })) };
  const auth = (req, res, next) => { const owner = req.get("x-test-owner"); if (!owner) return res.status(401).json({ error: "auth_required" }); req.auth = { userId: owner, source: req.get("x-test-source") || "clerk" }; next(); };
  const app = express(); app.use(express.json());
  app.use("/v1", buildPublicPlayersRouter({ players, preferences, auth, rateLimitPerMinute: limit }));
  const oldProfile = { getPublicProfile: jest.fn(async () => ({ displayName: "Should not bypass new privacy" })) };
  app.use("/v1", buildPublicProfileRouter({ publicProfile: oldProfile, players }));
  app.use((error, _req, res, _next) => res.status(error.status || 503).json({ error: { code: "temporarily_unavailable" } }));
  return { app, players, preferences, oldProfile };
}

describe("public player HTTP boundary", () => {
  test("public canonical reads need no account and are not shared HTTP caches", async () => {
    const h = fixture();
    const result = await request(h.app).get("/v1/public/players/public-name-0123456789");
    expect(result.status).toBe(200); expect(result.headers["cache-control"]).toBe("no-store");
    expect(h.preferences.get).not.toHaveBeenCalled();
  });
  test("missing and private receive the same neutral 404", async () => {
    const h = fixture();
    const missing = await request(h.app).get("/v1/public/players/missing-0123456789");
    const hidden = await request(h.app).get("/v1/public/players/private-0123456789");
    expect(missing.status).toBe(404); expect(hidden.body).toEqual(missing.body);
    expect(JSON.stringify(hidden.body)).not.toMatch(/owner|userId|email|enabled/);
  });
  test("a transient service failure stays a server error, not a private/missing 404", async () => {
    const h = fixture(); h.players.get.mockRejectedValueOnce(new Error("Private database detail"));
    const result = await request(h.app).get("/v1/public/players/public-name-0123456789");
    expect(result.status).toBe(503); expect(JSON.stringify(result.body)).not.toContain("Private database detail");
  });
  test("public rate bucket is scoped to IP and player slug", async () => {
    const h = fixture(2);
    for (let i = 0; i < 2; i += 1) expect((await request(h.app).get("/v1/public/players/public-one-0123456789")).status).toBe(200);
    expect((await request(h.app).get("/v1/public/players/public-one-0123456789")).status).toBe(429);
    expect((await request(h.app).get("/v1/public/players/public-two-0123456789")).status).toBe(200);
  });
  test("the old profile API cannot bypass an explicit new-profile OFF choice", async () => {
    const h = fixture();
    const result = await request(h.app).get("/v1/public/profile/private-0123456789");
    expect(result.status).toBe(404); expect(h.oldProfile.getPublicProfile).not.toHaveBeenCalled();
    expect(result.headers["cache-control"]).toBe("no-store");
  });
  test("sitemap is its own bounded public source and does not resolve profiles", async () => {
    const h = fixture();
    expect((await request(h.app).get("/v1/public/players-sitemap")).body).toEqual({ items: [] });
    expect(h.players.sitemap).toHaveBeenCalledTimes(1); expect(h.players.get).not.toHaveBeenCalled();
  });
});

describe("owner profile HTTP controls", () => {
  test.each([["get", "/me/public-profile"], ["get", "/me/public-profile/slug?slug=public-name-0123456789"], ["put", "/me/public-profile"]])("%s %s requires owner auth", async (method, path) => {
    const h = fixture(); expect((await request(h.app)[method](`/v1${path}`).send({ enabled: true })).status).toBe(401);
    expect(h.preferences.get).not.toHaveBeenCalled(); expect(h.preferences.set).not.toHaveBeenCalled(); expect(h.preferences.availability).not.toHaveBeenCalled();
  });
  test("authenticated reads and writes use the authenticated owner, never a body id", async () => {
    const h = fixture();
    const result = await request(h.app).put("/v1/me/public-profile").set("x-test-owner", "owner-a").send({ enabled: false, userId: "owner-b" });
    expect(result.status).toBe(200); expect(h.preferences.set).toHaveBeenCalledWith("owner-a", { enabled: false, userId: "owner-b" });
    expect(result.headers["cache-control"]).toBe("private, no-store");
  });
  test("availability uses a private, advisory read", async () => {
    const h = fixture();
    const result = await request(h.app).get("/v1/me/public-profile/slug?slug=public-name-0123456789").set("x-test-owner", "owner-a");
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(h.preferences.availability).toHaveBeenCalledWith("owner-a", "public-name-0123456789");
  });
  test.each(["device", "agent"])("a paired %s credential cannot grant publication consent", async source => {
    const h = fixture();
    const result = await request(h.app).put("/v1/me/public-profile").set("x-test-owner", "owner-a").set("x-test-source", source).send({ enabled: true });
    expect(result.status).toBe(403); expect(result.body.error.code).toBe("clerk_required");
    expect(h.preferences.set).not.toHaveBeenCalled(); expect(result.headers["cache-control"]).toBe("private, no-store");
    expect((await request(h.app).get("/v1/me/public-profile").set("x-test-owner", "owner-a").set("x-test-source", source)).status).toBe(200);
  });
});
