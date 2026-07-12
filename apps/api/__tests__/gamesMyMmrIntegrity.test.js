// @ts-nocheck
"use strict";

/**
 * Regression for the flat MMR-history incident.
 *
 * The retired ingest fallback asked SC2Pulse for the streamer's current
 * regional MMR whenever a replay omitted its game-time rating. During a
 * history resync every old NA game therefore received the same current
 * value (and every EU game another), producing a perfectly flat chart.
 * Historical game rows must now accept only replay-authored MMR.
 */

const express = require("express");
const request = require("supertest");
const { buildGamesRouter } = require("../src/routes/games");

function buildTestApp() {
  const upserts = [];
  const games = {
    upsert: jest.fn(async (_userId, game) => {
      upserts.push(game);
      return true;
    }),
  };
  const opponents = { refreshMetadata: jest.fn(async () => ({})) };
  const pulseMmr = {
    getCurrentMmrForAny: jest.fn(async () => ({ mmr: 5400, region: "NA" })),
  };
  const users = {
    getProfile: jest.fn(async () => ({ pulseIds: ["123"] })),
    addPulseId: jest.fn(async () => true),
  };
  const auth = (req, _res, next) => {
    req.auth = { userId: "u1" };
    next();
  };
  const app = express();
  app.use(express.json());
  // Pass the retired dependency deliberately: the router must ignore it
  // even if an older app composition still supplies it.
  app.use(buildGamesRouter({ games, opponents, pulseMmr, users, auth }));
  return { app, pulseMmr, upserts, users };
}

function game(overrides = {}) {
  return {
    gameId: "g1",
    date: "2026-04-01T12:00:00.000Z",
    result: "Victory",
    myRace: "Protoss",
    map: "Site Delta",
    myMmrSource: "unavailable",
    ...overrides,
  };
}

describe("POST /games preserves game-time MMR integrity", () => {
  test("never substitutes current Pulse MMR for a missing replay rating", async () => {
    const { app, pulseMmr, upserts, users } = buildTestApp();
    const res = await request(app).post("/games").send(game());

    expect(res.status).toBe(202);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].myMmr).toBeUndefined();
    expect(upserts[0].myMmrSource).toBe("unavailable");
    expect(pulseMmr.getCurrentMmrForAny).not.toHaveBeenCalled();
    expect(users.getProfile).not.toHaveBeenCalled();
  });

  test("retains an MMR explicitly extracted from the replay", async () => {
    const { app, upserts } = buildTestApp();
    const res = await request(app)
      .post("/games")
      .send(game({ myMmr: 5378, myMmrSource: "replay" }));

    expect(res.status).toBe(202);
    expect(upserts[0].myMmr).toBe(5378);
    expect(upserts[0].myMmrSource).toBe("replay");
  });
});
