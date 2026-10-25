// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { buildOpponentsRouter } = require("../src/routes/opponents");

function fixture() {
  const brief = { pulseId: "rival", totals: { total: 2 } };
  const rich = { ...brief, gamesScouting: [{ gameId: "owned-replay" }], medianTimings: { SpawningPool: 120 } };
  const opponents = { get: jest.fn().mockResolvedValue(brief), getAnalysis: jest.fn().mockResolvedValue(rich) };
  const app = express();
  app.use("/v1", buildOpponentsRouter({ opponents, auth: (req, res, next) => {
    const token = req.get("authorization");
    if (!token) return res.status(401).json({ error: { code: "auth_required" } });
    req.auth = { userId: "paired-owner", source: token === "Bearer paired-device" ? "device" : "clerk" }; next();
  } }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: { code: err.code || "internal_error" } }));
  const get = token => request(app).get("/v1/opponents/rival").set("Authorization", `Bearer ${token}`).set("Accept", "application/json");
  return { app, opponents, rich, brief, get };
}

describe("installed native Companion profile compatibility", () => {
  test("the old Authorization/Accept request retains rich owned analysis without a new capability header", async () => {
    const { get, opponents, rich } = fixture();
    const res = await get("paired-device").query({ since: "2026-09-01", until: "2026-09-30", race: "P", opp_race: "Z", map_pool: "ladder", game_size: "1v1", mergeLinked: "1" });
    expect(res.status).toBe(200); expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body).toEqual({ ...rich, communityAvailable: false });
    expect(opponents.get).not.toHaveBeenCalled();
    expect(opponents.getAnalysis).toHaveBeenCalledWith("paired-owner", "rival", {
      includeProfile: true, mergeLinked: true,
      filters: expect.objectContaining({ since: new Date("2026-09-01"), until: new Date("2026-09-30"), race: "P", oppRace: "Z", mapPool: "ladder", gameSize: "1v1" }),
    });
  });

  test("Clerk web requests keep the same filters and never hydrate the default route", async () => {
    const { get, opponents, brief } = fixture();
    const res = await get("clerk-session").query({ race: "T", mergeLinked: "1" });
    expect(res.status).toBe(200); expect(res.headers["cache-control"]).toBe("private, no-store"); expect(res.body).toEqual({ ...brief, communityAvailable: false });
    expect(opponents.getAnalysis).not.toHaveBeenCalled();
    expect(opponents.get).toHaveBeenCalledWith("paired-owner", "rival", { filters: expect.objectContaining({ race: "T" }), mergeLinked: true });
  });

  test("native admission/busy errors remain retryable and never fall back to a false empty brief", async () => {
    const { get, opponents } = fixture();
    opponents.getAnalysis.mockRejectedValue(Object.assign(new Error("Analysis queue busy"), { status: 503, code: "opponent_profile_busy" }));
    const res = await get("paired-device");
    expect(res.status).toBe(503); expect(res.headers["cache-control"]).toBe("private, no-store"); expect(res.body.error.code).toBe("opponent_profile_busy");
    expect(opponents.getAnalysis).toHaveBeenCalledTimes(1); expect(opponents.get).not.toHaveBeenCalled();
  });

  test("missing owned profiles retain404 and signed-out requests do no work", async () => {
    const { get, app, opponents } = fixture(); opponents.getAnalysis.mockResolvedValue(null);
    expect((await get("paired-device")).status).toBe(404);
    opponents.getAnalysis.mockClear();
    expect((await request(app).get("/v1/opponents/rival").set("Accept", "application/json")).status).toBe(401);
    expect(opponents.getAnalysis).not.toHaveBeenCalled(); expect(opponents.get).not.toHaveBeenCalled();
  });
});
