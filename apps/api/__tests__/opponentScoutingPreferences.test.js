// @ts-nocheck
"use strict";
const express = require("express"), request = require("supertest");
const { buildMeRouter } = require("../src/routes/me");
const { sanitizeOpponentScouting } = require("../src/util/opponentScoutingPreferences");

function fixture() {
  const values = new Map([["owner-a", { groupByPlayer: true, secret: "strip" }], ["owner-b", { groupByPlayer: false }]]);
  const users = { getPreferences: jest.fn(async id => values.get(id)), updatePreferences: jest.fn(async (id, type, body) => { values.set(id, body); return body; }) };
  const changed = jest.fn(), app = express(); app.use(express.json());
  app.use("/v1", buildMeRouter({ users, onScoutingChanged: changed, auth: (req, res, next) => {
    const userId = req.get("authorization"); if (!userId) return res.sendStatus(401); req.auth = { userId }; next();
  } }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: { code: err.code } }));
  return { app, values, users, changed };
}

test("default and sanitized reads expose one boolean; strict writes reject unknown fields or coercions", () => {
  expect(sanitizeOpponentScouting(null)).toEqual({ groupByPlayer: true });
  expect(sanitizeOpponentScouting({ groupByPlayer: false, other: "strip" })).toEqual({ groupByPlayer: false });
  for (const value of [null, [], {}, { groupByPlayer: "false" }, { groupByPlayer: 0 }, { groupByPlayer: false, userId: "other" }]) expect(() => sanitizeOpponentScouting(value, true)).toThrow();
});

test("authenticated preference round trip is private and owner-isolated, with invalidation after save", async () => {
  const { app, users, values, changed } = fixture();
  const get = await request(app).get("/v1/me/preferences/opponentScouting").set("authorization", "owner-a");
  expect(get.status).toBe(200); expect(get.body).toEqual({ groupByPlayer: true });
  expect(get.headers["cache-control"]).toBe("private, no-store");
  const put = await request(app).put("/v1/me/preferences/opponentScouting").set("authorization", "owner-a").send({ groupByPlayer: false });
  expect(put.status).toBe(200); expect(put.headers["cache-control"]).toBe("private, no-store");
  expect(users.updatePreferences).toHaveBeenCalledWith("owner-a", "opponentScouting", { groupByPlayer: false });
  expect(values.get("owner-b")).toEqual({ groupByPlayer: false }); expect(changed).toHaveBeenCalledWith("owner-a");
  expect((await request(app).get("/v1/me/preferences/opponentScouting")).status).toBe(401);
});

test("invalid writes retain saved preference and never invalidate another owner's caches", async () => {
  const { app, users, changed } = fixture();
  const bad = await request(app).put("/v1/me/preferences/opponentScouting").set("authorization", "owner-a").send({ groupByPlayer: false, userId: "owner-b" });
  expect(bad.status).toBe(400); expect(bad.body.error.code).toBe("invalid_opponent_scouting");
  expect(users.updatePreferences).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
});
