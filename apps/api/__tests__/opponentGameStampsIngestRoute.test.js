// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { buildGamesRouter } = require("../src/routes/games");

const owner = Object.freeze({ userId: "u1", id: "captured-owner", epoch: "00000000-0000-4000-8000-000000000001", compatibility: false });
const game = (gameId, extra = {}) => ({ gameId, date: "2026-05-01T00:00:00.000Z", result: "Victory", myRace: "Zerg", map: "Site Delta",
  opponent: { pulseId: `pulse-${gameId}`, toonHandle: "2-S2-1-5", displayName: "Rival", race: "Terran" }, ...extra });
function ingestApp({ withWriter = true, recordGame, refreshMetadata } = {}) {
  const capture = jest.fn(async () => owner);
  const games = { ...(withWriter ? { gameStatsWrites: { capture } } : {}),
    upsert: jest.fn(async (_userId, payload) => !payload.gameId.startsWith("old")) };
  const opponents = { recordGame: jest.fn(recordGame || (async () => ({ upgraded: false }))),
    refreshMetadata: jest.fn(refreshMetadata || (async () => ({ upgraded: false }))) };
  const log = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.log = log; next(); });
  app.use(buildGamesRouter({ games, opponents, auth: (req, _res, next) => { req.auth = { userId: "u1" }; next(); },
    testOnlyAllowMissingReplayIngestAdmission: true }));
  return { app, capture, games, opponents, log };
}

test("one batch owner is forwarded by identity to both opponent producers", async () => {
  const h = ingestApp();
  const response = await request(h.app).post("/games").send({ games: [game("new-1"), game("old-1"), game("new-2")] });
  expect(response.status).toBe(202); expect(response.body.rejected).toEqual([]);
  expect(h.capture).toHaveBeenCalledTimes(1);
  expect(h.opponents.recordGame).toHaveBeenCalledTimes(2); expect(h.opponents.refreshMetadata).toHaveBeenCalledTimes(1);
  for (const call of [...h.opponents.recordGame.mock.calls, ...h.opponents.refreshMetadata.mock.calls]) {
    expect(call[0]).toBe("u1"); expect(call[2]).toEqual({ statsOwner: owner }); expect(call[2].statsOwner).toBe(owner);
    expect(Object.keys(call[2])).toEqual(["statsOwner"]);
  }
  expect(h.opponents.recordGame.mock.calls[0][1]).toMatchObject({ gameId: "new-1", pulseId: "pulse-new-1", result: "Victory" });
  expect(h.opponents.refreshMetadata.mock.calls[0][1]).toMatchObject({ gameId: "old-1", pulseId: "pulse-old-1" });
});

test("a writer-less harness forwards an own undefined statsOwner, never an omitted one", async () => {
  const h = ingestApp({ withWriter: false });
  const response = await request(h.app).post("/games").send({ games: [game("new-1"), game("old-1")] });
  expect(response.status).toBe(202);
  for (const call of [h.opponents.recordGame.mock.calls[0], h.opponents.refreshMetadata.mock.calls[0]]) {
    expect(Object.hasOwn(call[2], "statsOwner")).toBe(true); expect(call[2].statsOwner).toBeUndefined();
  }
});

test.each(["recordGame", "refreshMetadata"])("a %s rejection stays advisory and the game stays accepted", async method => {
  const failure = new Error(`${method} failed`), h = ingestApp({ [method]: async () => { throw failure; } });
  const gameId = method === "recordGame" ? "new-1" : "old-1";
  const response = await request(h.app).post("/games").send(game(gameId));
  expect(response.status).toBe(202); expect(response.body.rejected).toEqual([]);
  expect(response.body.accepted).toEqual([expect.objectContaining({ gameId })]);
  expect(h.log.warn).toHaveBeenCalledWith({ err: failure, gameId, userId: "u1", pulseId: `pulse-${gameId}` }, "ingest_opponent_metadata_failed");
});
