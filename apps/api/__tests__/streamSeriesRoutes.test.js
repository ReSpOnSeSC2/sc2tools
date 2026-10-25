// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { buildMultichatRouter } = require("../src/routes/multichat");
const { buildGamesRouter } = require("../src/routes/games");
const base = { date: "2026-10-25T10:10:00Z", startedAt: "2026-10-25T10:00:00Z", result: "Victory", myRace: "Protoss", map: "Alcyone",
  opponent: { displayName: "Clem", toonHandle: "2-S2-1-99", race: "Terran" } };
function controls(series) {
  const app = express(); app.use(express.json());
  app.use(buildMultichatRouter({ overlayTokens: { resolve: async token => token === "good" ? { userId: "owner" } : null },
    users: { getPreferences: async () => ({}) }, studio: {}, series }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: { code: error.code } })); return app;
}
test("Series controls share token admission and no-store, including rejected credentials", async () => {
  const series = { get: jest.fn(async () => null), act: jest.fn(async () => ({ revision: 1 })) }, app = controls(series);
  const rejected = await request(app).post("/multichat/foreign/series").send({ action: "start" });
  expect(rejected.status).toBe(401); expect(rejected.headers["cache-control"]).toBe("no-store"); expect(series.act).not.toHaveBeenCalled();
  const read = await request(app).get("/multichat/good/series"); expect(read.status).toBe(200); expect(read.body).toBeNull();
  expect(series.get).toHaveBeenCalledWith("good", "owner");
  const body = { action: "start", revision: 0, format: 3, opponentName: "Clem" };
  const write = await request(app).post("/multichat/good/series").send(body);
  expect(write.status).toBe(200); expect(write.headers["cache-control"]).toBe("no-store"); expect(series.act).toHaveBeenCalledWith("good", "owner", body);
});
test("an unavailable service fails closed instead of returning fake defaults", async () => {
  const response = await request(controls()).get("/multichat/good/series");
  expect(response.status).toBe(503); expect(response.body.error.code).toBe("series_unavailable");
});
test("ingest forwards all and only accepted real rows, including custom and exact start/toon, without live IO", async () => {
  const series = { ingest: jest.fn(async () => {}) };
  const games = { upsertWithRevision: jest.fn(async (_owner, game) => {
    if (game.gameId === "failed") throw new Error("storage unavailable");
    return { created: true, excluded: game.gameId === "hidden" };
  }), quarantineResumedReplay: jest.fn(async () => ({ created: true })) };
  const app = express(); app.use(express.json());
  app.use(buildGamesRouter({ games, opponents: { refreshMetadata: async () => ({}) }, series, auth: (req, _res, next) => { req.auth = { userId: "owner" }; next(); }, testOnlyAllowMissingReplayIngestAdmission: true }));
  const response = await request(app).post("/games").send({ games: [
    { ...base, gameId: "one", isLadderGame: true }, { ...base, gameId: "two", isLadderGame: false },
    { ...base, gameId: "hidden" }, { ...base, gameId: "failed" }, { ...base, gameId: "resumed", isResumedFromReplay: true },
    { ...base, gameId: 123 },
  ] });
  expect(response.status).toBe(202);
  expect(response.body).toMatchObject({ accepted: expect.arrayContaining([{ gameId: "one", created: true }, { gameId: "two", created: true }]) });
  expect(series.ingest).toHaveBeenCalledTimes(1);
  const [owner, rows] = series.ingest.mock.calls[0]; expect(owner).toBe("owner");
  expect(rows.map(row => row.gameId)).toEqual(["one", "two"]);
  for (const row of rows) expect(row).toMatchObject({ startedAt: base.startedAt, opponent: { toonHandle: "2-S2-1-99" } });
  expect(response.body.rejected.some(row => row.gameId === 123)).toBe(true);
});
