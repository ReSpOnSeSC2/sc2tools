// @ts-nocheck
"use strict";
const express = require("express"), request = require("supertest");
const { buildAgentLiveRouter } = require("../src/routes/agentLive");
const { loadConfig } = require("../src/config/loader");
const { startHarness, sampleGame, userIdForClerk } = require("./helpers/browserIngestHarness");
jest.mock("@clerk/backend", () => ({ verifyToken: jest.fn(async () => ({ sub: "clerk_twitch_fixture" })) }));

test("master gate is false unless the owner separately sets its exact explicit true value", () => {
  const env = { MONGODB_URI: "mongodb://fixture.invalid/test", CLERK_SECRET_KEY: "mock-only", SERVER_PEPPER_HEX: "a".repeat(64) };
  for (const value of [undefined, "", "false", "1", "on"]) expect(loadConfig({ ...env, TWITCH_AUTOMATION_ENABLED: value }).twitchAutomationEnabled).toBe(false);
  expect(loadConfig({ ...env, TWITCH_AUTOMATION_ENABLED: "true" }).twitchAutomationEnabled).toBe(true);
});
test.each([["clerk", true, true, "match_loading", 0], ["device", false, true, "match_loading", 0], ["device", true, false, "match_loading", 0],
  ["device", true, true, "match_in_progress", 0], ["device", true, true, "match_loading", 1], ["device", true, true, "match_started", 1]])("accepted device source/gate/phase admission %s %s %s %s", async (source, enabled, accepted, phase, calls) => {
  const automation = { deps: { enabled }, onLive: jest.fn(async () => {}) };
  const app = express(); app.use(express.json()); app.use("/v1", buildAgentLiveRouter({ twitchAutomation: automation,
    broker: { publish: () => accepted }, auth: (req, _res, next) => { req.auth = { userId: "owner", source }; next(); } }));
  await request(app).post("/v1/agent/live").send({ gameKey: "fixture-game", phase, isReplay: false, isRanked: true, queue: "ranked1v1" }).expect(200);
  expect(automation.onLive).toHaveBeenCalledTimes(calls);
  if (calls) expect(automation.onLive).toHaveBeenCalledWith("owner", expect.any(Object), { source: "device", receivedAt: expect.any(Number) }, null);
});

describe("real ingest hook without overlays or provider activation", () => {
  let harness;
  beforeAll(async () => { harness = await startHarness("twitch_ingest_wiring", { twitchAutomationEnabled: true }); });
  afterAll(async () => { await harness?.stop(); });
  test("only a freshly created replay invokes the independent settlement adapter once", async () => {
    await request(harness.app).get("/v1/me").set("authorization", "Bearer local-mock").expect(200);
    const owner = await userIdForClerk(harness.db, "clerk_twitch_fixture");
    const settle = jest.spyOn(harness.services.twitchAutomation, "settleVerifiedReplay").mockResolvedValue(null);
    const record = sampleGame(53, { gameId: "twitch-mocked-replay", date: new Date().toISOString(), startedAt: new Date(Date.now() - 620_000).toISOString() });
    await request(harness.app).post("/v1/games").set("authorization", "Bearer local-mock").send({ games: [record] }).expect(202);
    expect(settle).toHaveBeenCalledTimes(1); expect(settle).toHaveBeenCalledWith(owner, record.gameId, expect.objectContaining({ gameId: record.gameId, opponent: expect.objectContaining({ displayName: "Opp" }) }));
    await request(harness.app).post("/v1/games").set("authorization", "Bearer local-mock").send({ games: [record] }).expect(202);
    expect(settle).toHaveBeenCalledTimes(1); settle.mockRestore();
  });
});
