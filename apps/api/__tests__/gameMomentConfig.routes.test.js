"use strict";
const express = require("express"), request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { UsersService } = require("../src/services/users");
const { buildMeRouter } = require("../src/routes/me");
const { buildMultichatRouter } = require("../src/routes/multichat");
/** @type {MongoMemoryServer} */ let mongo;
/** @type {MongoClient} */ let client;
/** @type {import('mongodb').Db} */ let db;
/** @type {import('express').Express} */ let app;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); db = client.db("moment_settings");
  const users = new UsersService(/** @type {any} */ ({ users: db.collection("users") }));
  const auth = /** @type {import('express').RequestHandler} */ ((req, _res, next) => { req.auth = /** @type {any} */ ({ userId: "owner" }); next(); });
  app = express(); app.use(express.json());
  app.use("/v1", buildMeRouter(/** @type {any} */ ({ users, auth })));
  app.use("/v1", buildMultichatRouter(/** @type {any} */ ({ users, overlayTokens: { resolve: async (/** @type {string} */ token) => token === "owned" ? { userId: "owner" } : null }, studio: {}, tiktokRelay: {} })));
  app.use(/** @type {import('express').ErrorRequestHandler} */ ((error, _req, res, _next) => res.status(error.status || 500).json({ error: { code: error.code || "unavailable" } })));
});
afterAll(async () => { await client?.close(); await mongo?.stop(); });
beforeEach(async () => { await db.collection("users").deleteMany({}); await db.collection("users").insertMany([{ userId: "owner" }, { userId: "foreign" }]); });

test("owner Save stores a complete bounded preference and the actual overlay config exposes the same safe choices", async () => {
  const saved = await request(app).put("/v1/me/preferences/multichat").send({ alerts: { gameMoments: { mmrStep: 250, moments: { winStreak: { enabled: true, preset: "classic", sound: "ding" } } } } });
  expect(saved.status).toBe(200); expect(Object.keys(saved.body.alerts.gameMoments.moments)).toHaveLength(9);
  const overlay = await request(app).get("/v1/multichat/owned/config");
  expect(overlay.status).toBe(200); expect(overlay.body.config.alerts.gameMoments).toEqual(saved.body.alerts.gameMoments);
  expect(overlay.body.config.alerts.gameMoments.botPost).toBe(false);
  expect((await db.collection("users").findOne({ userId: "foreign" }))?.preferences).toBeUndefined();
});
test.each([{ mmrStep: 1 }, { moments: { winStreak: { enabled: "true" } } }, { moments: { winStreak: { sound: "https://outside.test/audio.mp3" } } }])("malformed moment Save fails closed without a partial settings write: %j", async gameMoments => {
  const response = await request(app).put("/v1/me/preferences/multichat").send({ alerts: { gameMoments } });
  expect(response.status).toBe(400); expect(response.body.error.code).toBe("invalid_game_moments");
  expect((await db.collection("users").findOne({ userId: "owner" }))?.preferences).toBeUndefined();
});
test("corrupt old settings are sanitized on the token route and retired credentials stay unauthorized", async () => {
  await db.collection("users").updateOne({ userId: "owner" }, { $set: { "preferences.multichat": { alerts: { gameMoments: { botPost: "true", moments: { winStreak: { enabled: 1, preset: "missing", sound: "https://outside.test/file" } } } } } } });
  const response = await request(app).get("/v1/multichat/owned/config");
  expect(response.body.config.alerts.gameMoments).toMatchObject({ botPost: false, moments: { winStreak: { enabled: false, sound: "none" } } });
  expect((await request(app).get("/v1/multichat/retired/config")).status).toBe(401);
});
