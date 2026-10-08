// @ts-nocheck
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const request = require("supertest");
const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { sha256 } = require("../src/util/hash");
const oauth = require("../src/services/platformOauthClients");

jest.mock("@clerk/backend", () => ({ verifyToken: jest.fn(async (token) => {
  if (token === "fixture-clerk-session") return { sub: "fixture-web-user" };
  throw new Error("invalid fixture session");
}) }));

describe("real buildApp paired-agent stream control boundary", () => {
  let mongo, db, app, services, cache, databaseDirectory, denyNetwork;
  const deviceToken = "fixture-agent-token-not-a-real-secret-123456";
  const owner = "fixture-owner-user";
  const providerFetch = jest.fn();
  let currentTitle = "Original fixture title";
  const config = { port: 0, nodeEnv: "test", logLevel: "silent", mongoUri: "", mongoDb: "streaming_boundary",
    clerkSecretKey: "fixture-clerk-key", serverPepper: Buffer.alloc(32, 1), corsAllowedOrigins: [],
    rateLimitPerMinute: 1000, agentReleaseAdminToken: "fixture-admin-key", pythonExe: null,
    pythonAnalyzerDir: "/fixture-no-python-analyzer", platformIntegrations: { enabled: true,
      encryptionKey: Buffer.alloc(32, 17),
      twitch: { clientId: "fixture-own-twitch", clientSecret: "fixture-own-secret",
        redirectUri: "https://api.sc2tools.com/v1/integrations/twitch/callback" },
    } };

  beforeAll(async () => {
    denyNetwork = jest.spyOn(global, "fetch").mockImplementation(() => { throw new Error("Real platform network forbidden"); });
    cache = path.resolve(__dirname, "../node_modules/.cache/streaming-integration");
    fs.mkdirSync(cache, { recursive: true });
    databaseDirectory = fs.mkdtempSync(path.join(cache, "fixture-db-"));
    mongo = await MongoMemoryServer.create({
      binary: { downloadDir: path.join(cache, "mongodb-binaries") },
      instance: { dbPath: databaseDirectory, ip: "127.0.0.1" },
    });
    db = await connect({ uri: mongo.getUri(), dbName: "streaming_boundary" });
    ({ app, services } = buildApp({ db, logger: pino({ level: "silent" }), config }));
    await db.deviceTokens.insertOne({ tokenHash: sha256(deviceToken), userId: owner, revokedAt: null });
    providerFetch.mockImplementation(async (url, init = {}) => {
      if (String(url).includes("oauth2/validate")) return Response.json({ user_id: "42", login: "fixture_streamer",
        client_id: "fixture-own-twitch", scopes: oauth.STREAMING_SCOPES.twitch });
      if (String(url).includes("/helix/channels")) {
        if (init.method === "PATCH") { currentTitle = JSON.parse(init.body).title; return new Response(null, { status: 204 }); }
        return Response.json({ data: [{ broadcaster_id: "42", title: currentTitle }] });
      }
      throw new Error("Unexpected provider fixture endpoint");
    });
    services.platformIntegrations.rawFetchImpl = providerFetch;
    await services.platformIntegrations.vault.saveConnection(owner, "twitch", {
      accessToken: "fixture-private-access", refreshToken: "fixture-private-refresh", expiresAt: new Date(Date.now() + 3_600_000),
      scopes: oauth.STREAMING_SCOPES.twitch, platformUserId: "42", platformUserName: "fixture_streamer",
      metadata: { streamingConsent: true },
    });
  }, 180_000);

  afterAll(async () => {
    await services?.platformIntegrations.stop?.();
    if (db) await db.close();
    if (mongo) await mongo.stop();
    denyNetwork?.mockRestore();
    if (databaseDirectory) {
      const resolved = path.resolve(databaseDirectory);
      if (!resolved.startsWith(path.resolve(cache) + path.sep)) throw new Error("Fixture cleanup escaped its cache root");
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
  function agent(req) { return req.set("authorization", `Bearer ${deviceToken}`); }

  test("actual mounted router accepts device auth and keeps normal web integrations Clerk-only", async () => {
    const response = await agent(request(app).get("/v1/agent/streaming/status")).expect(200);
    expect(response.body.platforms.find((row) => row.platform === "twitch"))
      .toMatchObject({ platformUserId: "42", streamingReady: true, title: currentTitle });
    expect(JSON.stringify(response.body)).not.toContain("fixture-private");
    await agent(request(app).get("/v1/me/integrations")).expect(403);
    await request(app).get("/v1/me/integrations").set("authorization", "Bearer fixture-clerk-session").expect(200);
    await request(app).get("/v1/agent/streaming/status").expect(401);
  });
  test("cannot override user ownership and applies valid title only through owner-pinned grant", async () => {
    const before = providerFetch.mock.calls.length;
    await agent(request(app).post("/v1/agent/streaming/title"))
      .send({ title: "Foreign title", userId: "someone-else", platforms: ["twitch"] }).expect(400);
    expect(providerFetch.mock.calls.length).toBe(before);
    const response = await agent(request(app).post("/v1/agent/streaming/title"))
      .send({ title: "Owner title", platforms: ["twitch"] }).expect(200);
    expect(response.body.platforms[0]).toMatchObject({ streamingReady: true, title: "Owner title", updated: true });
    expect(currentTitle).toBe("Owner title");
    expect((await db.platformConnections.findOne({ userId: owner, platform: "twitch" })).streamingLease).toBeUndefined();
  });
  test("new agent connect produces an explicit, one-time owner-bound streaming OAuth state", async () => {
    const response = await agent(request(app).post("/v1/agent/streaming/twitch/connect")).send({}).expect(200);
    const url = new URL(response.body.authorizeUrl);
    expect(url.hostname).toBe("id.twitch.tv");
    expect(url.searchParams.get("scope")).toContain("channel:manage:broadcast");
    const pending = await services.platformIntegrations.vault.consumeOauthState(url.searchParams.get("state"), "twitch");
    expect(pending).toMatchObject({ userId: owner, purpose: "streaming" });
    expect(await services.platformIntegrations.vault.consumeOauthState(url.searchParams.get("state"), "twitch")).toBeNull();
  });
});
