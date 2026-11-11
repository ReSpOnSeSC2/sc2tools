"use strict";

const express = require("express");
const { pino } = require("pino");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { buildSupporterWallRouter } = require("../src/routes/supporterWall");
const { buildErrorHandler } = require("../src/middleware/errorHandler");
const { SupporterWallService } = require("../src/services/supporterWall");

const NOW = new Date("2026-11-20T13:00:00Z");
/** @type {MongoMemoryServer} */ let mongo;
/** @type {MongoClient} */ let client;
/** @type {{supporters: import("mongodb").Collection, donationMonths: import("mongodb").Collection}} */ let db;
/** @type {Date} */ let now;
/** @type {import("express").Express} */ let server;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  const database = client.db("donation_tests");
  db = { supporters: database.collection("supporters"), donationMonths: database.collection("donation_months") };
  /** @type {import("express").RequestHandler} */
  const auth = (req, res, next) => {
    const userId = req.get("x-test-owner");
    if (!userId) { res.sendStatus(401); return; }
    req.auth = { userId, source: "clerk" };
    next();
  };
  server = express();
  server.use(express.json());
  server.use("/v1", buildSupporterWallRouter({
    supporterWall: new SupporterWallService(db, { now: () => now }),
    auth, isAdmin: req => req.auth?.userId === "admin",
  }));
  server.use(buildErrorHandler(pino({ level: "silent" })));
});
afterAll(async () => { await client?.close(); await mongo?.stop(); });
beforeEach(async () => {
  now = NOW;
  await Promise.all([db.donationMonths.deleteMany({}), db.supporters.deleteMany({})]);
});

test("monthly totals are admin-only, newest-first and public for at most 45 days", async () => {
  const totals = { receivedUsd: 41.12, supporterCount: 3 };
  /** @param {string} month */
  const update = (month) => request(server).put(`/v1/admin/donations/${month}`).send(totals);
  await update("2026-11").expect(401);
  await update("2026-11").set("x-test-owner", "owner").expect(403);
  await update("2026-12").set("x-test-owner", "admin").expect(400);
  await update("2026-11").set("x-test-owner", "admin").expect(200);
  await update("2026-10").set("x-test-owner", "admin").expect(200);
  const saved = await request(server).get("/v1/admin/donations/2026-11").set("x-test-owner", "admin").expect(200);
  expect(saved.headers["cache-control"]).toBe("private, no-store");
  expect(saved.body.coverage).toMatchObject(totals);
  const active = await request(server).get("/v1/public/donations/current").expect(200);
  expect(active.headers["cache-control"]).toContain("s-maxage=600");
  expect(active.body).toEqual({ coverage: { month: "2026-11", ...totals, updatedAt: NOW.toISOString() } });
  now = new Date(+NOW + 45 * 86400_000 + 1);
  await request(server).get("/v1/public/donations/current").expect(200, { coverage: null });
});

test("supporter edits require consent and new moderation before appearing publicly", async () => {
  /** @param {import("supertest").Test} req */
  const owner = (req) => req.set("x-test-owner", "owner");
  /** @param {import("supertest").Test} req */
  const admin = (req) => req.set("x-test-owner", "admin");
  /** @param {string} displayName @param {boolean} consent */
  const self = (displayName, consent) => owner(request(server).put("/v1/me/supporter-wall")).send({ displayName, consent });
  const pending = () => admin(request(server).get("/v1/admin/supporters")).expect(200);
  /** @param {{id: string, editId: string}} entry */
  const approve = ({ id, editId }) => admin(request(server).patch(`/v1/admin/supporters/${id}`)).send({ status: "approved", editId });
  const wall = () => request(server).get("/v1/public/supporters").expect("cache-control", "no-store").expect(200);
  await self("Nexus", false).expect(400);
  await self("Nexus", true).expect(200);
  expect((await wall()).body.thisMonth).toEqual([]);
  const stale = (await pending()).body.items[0];
  await self("Stargate", true).expect(200);
  await approve(stale).expect(409);
  await approve((await pending()).body.items[0]).expect(200);
  expect((await wall()).body.thisMonth).toEqual([{ displayName: "Stargate", message: "" }]);
  await owner(request(server).delete("/v1/me/supporter-wall")).expect(200);
  expect((await wall()).body.thisMonth).toEqual([]);
});
