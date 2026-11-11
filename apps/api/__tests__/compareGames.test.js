// @ts-nocheck
"use strict";

const request = require("supertest");
const { ObjectId } = require("mongodb");
const { createHarness } = require("./helpers/reviewsHarness");
jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const base = "/v1/compare-games";
const legacy = "date|Private Rival|Map / 600";
const mine = new ObjectId("0123456789abcdef01234567");
const theirs = new ObjectId("0123456789abcdef01234568");
const pending = new ObjectId("0123456789abcdef01234569");
const ref = id => "r-" + id.toHexString();
let h;

beforeAll(async () => {
  h = await createHarness();
  await h.seedUser("owner");
  await h.seedUser("other");
  await h.db.games.insertMany([
    { _id: mine, userId: "u_owner", gameId: legacy, date: new Date(), map: "Alcyone LE" },
    { _id: theirs, userId: "u_other", gameId: "their-game", date: new Date() },
    { _id: pending, userId: "u_owner", gameId: "pending-delete", _deletionPending: true },
  ]);
});
afterAll(async () => { await h.close(); });

test("mints only the owner's references and never echoes fallback IDs", async () => {
  const resolve = () => request(h.app).post(base + "/references");
  await resolve().send({ gameIds: [legacy] }).expect(401);
  const asOwner = () => resolve().set("authorization", h.bearer("owner"));
  await asOwner().send({ gameIds: [legacy, "their-game", "pending-delete"] }).expect(400);
  await asOwner().send({ gameIds: [{ $ne: null }] }).expect(400);
  const response = await asOwner().send({ gameIds: ["their-game", legacy] }).expect(200);
  expect(response.body).toEqual({ references: [null, ref(mine)] });
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect((await asOwner().send({ gameIds: ["pending-delete"] }).expect(200)).body).toEqual({ references: [null] });
});

test("checks ownership and deletion on every opaque resource read", async () => {
  const get = (id, resource, user) => request(h.app).get(base + "/" + id + "/" + resource).set("authorization", h.bearer(user));
  await request(h.app).get(base + "/" + ref(mine) + "/game").expect(401);
  const own = await get(ref(mine), "game", "owner").expect(200);
  expect(own.body.map).toBe("Alcyone LE");
  expect(own.headers["cache-control"]).toBe("private, no-store");
  for (const resource of ["game", "macro-breakdown", "build-order"]) {
    await get(ref(mine), resource, "other").expect(404);
    await get(ref(pending), resource, "owner").expect(404);
    await get(encodeURIComponent(legacy), resource, "owner").expect(404);
  }
});
