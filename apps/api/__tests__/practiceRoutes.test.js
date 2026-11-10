// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const pino = require("pino");
const { buildGamesRouter } = require("../src/routes/games");
const { buildPracticeRouter } = require("../src/routes/practice");
const { buildErrorHandler } = require("../src/middleware/errorHandler");

const baseGame = { date: "2026-11-02T00:00:00.000Z", result: "Victory", myRace: "Protoss", map: "Goldenaura", opponent: { race: "Zerg", pulseId: "p1" } };

function ingestApp(practice) {
  const events = [];
  const games = {
    gameStatsWrites: { capture: jest.fn(async () => ({ userId: "u1", id: "owner", epoch: "00000000-0000-4000-8000-000000000001", compatibility: false })) },
    upsertWithRevision: jest.fn(async () => { events.push("upsert"); return { created: true, customBuildRevision: "r", spatial: undefined }; }),
  };
  const customBuilds = { tagSingleGame: jest.fn(async () => { events.push("tag"); return null; }) };
  const spatial = { invalidateForUser: jest.fn(() => events.push("spatial")) };
  const app = express();
  app.use(express.json());
  app.use(buildGamesRouter({
    games, customBuilds, spatial, practice: practice(events),
    opponents: { recordGame: jest.fn(async () => ({})), refreshMetadata: jest.fn(async () => ({})) },
    auth: (req, _res, next) => { req.auth = { userId: "u1" }; next(); },
    testOnlyAllowMissingReplayIngestAdmission: true,
  }));
  return { app, events, spatial };
}

describe("ingest grades the practised matchup after the custom-build tag", () => {
  test("the armed slots are read once per batch and each stored game is offered for grading", async () => {
    const practice = (events) => ({
      ingestContext: jest.fn(async () => { events.push("context"); return { slots: {} }; }),
      recordIngested: jest.fn(async (_userId, game) => { events.push(`grade:${game.gameId}`); return null; }),
    });
    const h = ingestApp(practice);
    const res = await request(h.app).post("/games").send({ games: [{ ...baseGame, gameId: "g1", buildLog: ["[0:18] Pylon"] }, { ...baseGame, gameId: "g2" }] });
    expect(res.status).toBe(202);
    expect(res.body.accepted.map((row) => row.gameId)).toEqual(["g1", "g2"]);
    expect(h.events).toEqual(["upsert", "spatial", "tag", "context", "grade:g1", "upsert", "spatial", "tag", "grade:g2"]);
  });

  test("a grading failure is advisory and never rejects the game", async () => {
    const practice = () => ({
      ingestContext: jest.fn(async () => { throw new Error("users down"); }),
      recordIngested: jest.fn(),
    });
    const h = ingestApp(practice);
    const res = await request(h.app).post("/games").send({ ...baseGame, gameId: "g1" });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toEqual([expect.objectContaining({ gameId: "g1" })]);
    expect(res.body.rejected).toEqual([]);
  });
});

describe("routes/practice", () => {
  function practiceApp(userId = "u1") {
    const practice = {
      summary: jest.fn(async () => ({ matchup: "PvZ" })),
      games: jest.fn(async () => ({ items: [], nextCursor: null })),
      game: jest.fn(async () => ({ grade: "B" })),
      gradeRecent: jest.fn(async () => ({ matchup: "PvZ", considered: 0, graded: 0 })),
    };
    const app = express();
    app.use(express.json());
    app.use("/v1", buildPracticeRouter({ practice, auth: (req, _res, next) => { if (userId) req.auth = { userId }; next(); } }));
    app.use(buildErrorHandler(pino({ level: "silent" })));
    return { app, practice };
  }

  test("every read is the signed-in owner's and is never cached", async () => {
    const { app, practice } = practiceApp();
    const summary = await request(app).get("/v1/practice/summary?matchup=PvZ&targetHash=0123456789abcdef");
    expect(summary.status).toBe(200);
    expect(summary.headers["cache-control"]).toBe("private, no-store");
    expect(practice.summary).toHaveBeenCalledWith("u1", expect.objectContaining({ matchup: "PvZ", targetHash: "0123456789abcdef" }));
    expect((await request(app).get("/v1/practice/games?matchup=PvZ&limit=5")).status).toBe(200);
    expect((await request(app).get("/v1/practice/games/g1")).body).toEqual({ practice: { grade: "B" } });
    expect(practice.game).toHaveBeenCalledWith("u1", "g1");
    const graded = await request(app).post("/v1/practice/grade-recent").send({ matchup: "PvZ", userId: "someone-else" });
    expect(graded.status).toBe(200);
    expect(practice.gradeRecent).toHaveBeenCalledWith("u1", { matchup: "PvZ" });
  });

  test("a request without a signed-in owner is refused", async () => {
    const { app, practice } = practiceApp(null);
    expect((await request(app).get("/v1/practice/summary?matchup=PvZ")).status).toBe(401);
    expect(practice.summary).not.toHaveBeenCalled();
  });
});
