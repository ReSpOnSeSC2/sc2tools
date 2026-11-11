// @ts-nocheck
"use strict";

/**
 * Admin opponent and global-player game lists: explicit win/loss/tie/unknown
 * classification for the result filter, exact map and owner filters, and the
 * opponent head-to-head summary (decided games only feed the win rate; the
 * summary covers every game vs the opponent, not the loaded page).
 */

const express = require("express");
const request = require("supertest");
const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { AdminService } = require("../src/services/admin");
const { AdminGlobalService } = require("../src/services/adminGlobal");
const { buildAdminRouter } = require("../src/routes/admin");
const { buildErrorHandler } = require("../src/middleware/errorHandler");
const { resultClassOf } = require("../src/util/gameResultClass");

const PULSE = "1-S2-1-424242";
const day = (n) => new Date(Date.UTC(2026, 9, 1 + n, 12));
const game = (userId, n, result, map, extra = {}) => ({
  userId, gameId: `${userId}-g${n}`, date: day(n), result, map, durationSec: 600 + n, myRace: "Protoss",
  opponent: { pulseId: PULSE, displayName: "Rival", race: "Zerg" }, ...extra,
});

let mongo, db, app, admin, adminGlobal;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "admin_games_filters" });
  admin = new AdminService({ db, gdpr: {} });
  adminGlobal = new AdminGlobalService({ db, pulseDirectory: { coverage: async () => ({}) } });
  app = express();
  app.use(express.json());
  app.use("/v1", buildAdminRouter({
    auth: (req, _res, next) => { req.auth = { userId: "admin" }; next(); },
    isAdmin: (req) => req.get("x-admin") === "1",
    admin, adminGlobal, adminGlobalTrends: {}, adminEvents: {}, analytics: {}, gdpr: {}, games: {},
    opponents: {}, perGame: {}, users: {},
  }));
  app.use(buildErrorHandler(pino({ level: "silent" })));
});
afterAll(async () => { await db?.close(); await mongo?.stop(); });
beforeEach(async () => {
  await db.games.deleteMany({});
  await db.users.deleteMany({});
  await db.games.insertMany([
    game("owner", 1, "Victory", "Alcyone"),
    game("owner", 2, "Defeat", "Alcyone"),
    game("owner", 3, "Tie", "Alcyone"),
    game("owner", 4, "Undecided", "Pylon"),
    game("owner", 5, null, "Pylon", { durationSec: 0 }),
    game("owner", 6, " win ", "Ghost River"),
    game("owner", 7, "draw", "Ghost River"),
    // Legacy top-level alias only; still the same opponent.
    { ...game("owner", 8, "LOSS", "Pylon"), opponent: { displayName: "Rival", race: "Zerg" }, oppPulseId: PULSE },
    game("other", 9, "Victory", "Alcyone"),
    game("owner", 10, "Victory", "Alcyone", { opponent: { pulseId: "someone-else", race: "Terran" } }),
    game("owner", 11, "Victory", "Alcyone", { _deleted: true }),
    game("owner", 12, "Victory", "Alcyone", { _deletionPending: true }),
  ]);
});

const get = (path) => request(app).get(path).set("x-admin", "1");

describe("admin opponent game summary and filters", () => {
  test("resultOf classification: only victory/win, defeat/loss and tie/draw are decided", () => {
    expect(["Victory", " WIN ", "win"].map(resultClassOf)).toEqual(["win", "win", "win"]);
    expect(["Defeat", "loss"].map(resultClassOf)).toEqual(["loss", "loss"]);
    expect(["Tie", "draw"].map(resultClassOf)).toEqual(["tie", "tie"]);
    expect(["Undecided", "", null, undefined, 1].map(resultClassOf)).toEqual(Array(5).fill("unknown"));
  });

  test("first page summary counts every game vs the opponent; ties and unknowns are never decided", async () => {
    const res = await get(`/v1/admin/users/owner/opponents/${PULSE}/games?limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((g) => g.gameId)).toEqual(["owner-g8", "owner-g7"]);
    expect(res.body.summary).toMatchObject({ wins: 2, losses: 2, ties: 2, unknown: 2 });
    // Seven timed games (the 0 s row is excluded): 601..608 minus 605.
    expect(res.body.summary.avgDurationSec).toBe(Math.round((601 + 602 + 603 + 604 + 606 + 607 + 608) / 7));
    expect(res.body.summary.maps[0]).toEqual({ map: "Alcyone", games: 3, wins: 1, losses: 1, ties: 1 });
    expect(res.body.summary.mapOptions).toEqual(["Alcyone", "Pylon", "Ghost River"]);
    expect(res.body.summary.last10).toEqual(["loss", "tie", "win", "unknown", "unknown", "tie", "loss", "win"]);
    const older = await get(`/v1/admin/users/owner/opponents/${PULSE}/games?limit=2&before=${encodeURIComponent(res.body.nextBefore)}`);
    expect(older.body.summary).toBeUndefined();
    expect(older.body.items.map((g) => g.gameId)).toEqual(["owner-g6", "owner-g5"]);
  });

  test("result and map filters use the same classification and keep the summary unfiltered", async () => {
    const ties = await get(`/v1/admin/users/owner/opponents/${PULSE}/games?result=tie`);
    expect(ties.body.items.map((g) => g.gameId)).toEqual(["owner-g7", "owner-g3"]);
    expect(ties.body.summary.ties).toBe(2);
    expect(ties.body.summary.wins).toBe(2);
    const wins = await get(`/v1/admin/users/owner/opponents/${PULSE}/games?result=win`);
    expect(wins.body.items.map((g) => g.gameId)).toEqual(["owner-g6", "owner-g1"]);
    const losses = await get(`/v1/admin/users/owner/opponents/${PULSE}/games?result=loss&map=Pylon`);
    expect(losses.body.items.map((g) => g.gameId)).toEqual(["owner-g8"]);
    const map = await get(`/v1/admin/users/owner/opponents/${PULSE}/games?map=Ghost%20River`);
    expect(map.body.items.map((g) => g.gameId)).toEqual(["owner-g7", "owner-g6"]);
  });
});

describe("global player game filters", () => {
  test("global player games filter by result, map and owner", async () => {
    const all = await get(`/v1/admin/global/players/${PULSE}/games`);
    expect(all.body.items).toHaveLength(9);
    const wins = await get(`/v1/admin/global/players/${PULSE}/games?result=win`);
    expect(wins.body.items.map((g) => g.gameId)).toEqual(["other-g9", "owner-g6", "owner-g1"]);
    const owner = await get(`/v1/admin/global/players/${PULSE}/games?result=win&userId=owner&map=Alcyone`);
    expect(owner.body.items.map((g) => g.gameId)).toEqual(["owner-g1"]);
    const ties = await get(`/v1/admin/global/players/${PULSE}/games?result=tie&userId=other`);
    expect(ties.body.items).toEqual([]);
  });

  test("global player win rates count decided games only", async () => {
    await db.opponents.deleteMany({});
    await db.opponents.insertMany([
      { userId: "owner", pulseId: PULSE, displayNameSample: "Rival", race: "Z", gameCount: 10, wins: 3, losses: 3, lastSeen: day(2) },
      { userId: "other", pulseId: PULSE, displayNameSample: "Rival", race: "Z", gameCount: 3, wins: 1, losses: 1, lastSeen: day(1) },
    ]);
    const profile = await adminGlobal.playerProfile(PULSE);
    expect(profile.winRate).toBe(0.5);
    expect(profile.perUser.map((row) => row.winRate)).toEqual([0.5, 0.5]);
    const list = await adminGlobal.listPlayers({});
    expect(list.items[0]).toMatchObject({ gameCount: 13, wins: 4, losses: 4, winRate: 0.5 });
    await db.opponents.deleteMany({});
  });

  test("malformed filters are a 400, never an unfiltered list; non-admins get 403", async () => {
    for (const query of ["result=undecided", "result=Victory", "result[x]=win", "map=%20Pylon", "map=a&map=b"]) {
      expect((await get(`/v1/admin/users/owner/opponents/${PULSE}/games?${query}`)).status).toBe(400);
    }
    for (const query of ["userId=%20owner", "userId=a&userId=b", `userId=${"x".repeat(65)}`]) {
      expect((await get(`/v1/admin/global/players/${PULSE}/games?${query}`)).status).toBe(400);
    }
    expect((await request(app).get(`/v1/admin/global/players/${PULSE}/games?result=win`)).status).toBe(403);
  });
});
