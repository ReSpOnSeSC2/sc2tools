// @ts-nocheck
"use strict";

/** The heatmap routes resolve the dossier's opponent through the owner's own history. */
const express = require("express");
const request = require("supertest");
const pino = require("pino");
const { buildSpatialRouter } = require("../src/routes/spatial");
const { buildErrorHandler } = require("../src/middleware/errorHandler");

function harness({ clause = { "opponent.pulseId": "p1" } } = {}) {
  const deps = {
    spatial: {
      battle: jest.fn().mockResolvedValue({ ok: true, kind: "battle" }),
      opponentProxies: jest.fn().mockResolvedValue({ ok: true, kind: "opp_proxy" }),
    },
    opponents: { identityClause: jest.fn().mockResolvedValue(clause) },
    auth: (req, _res, next) => { req.auth = { userId: "u1" }; next(); },
  };
  const app = express();
  app.use("/v1", buildSpatialRouter(deps));
  app.use(buildErrorHandler(pino({ level: "silent" })));
  return { app, deps };
}

describe("routes/spatial opponent filter", () => {
  test("a dossier opponent is resolved for the caller and passed to the layer", async () => {
    const { app, deps } = harness();
    const res = await request(app).get("/v1/spatial/opponent-proxies?map=Goldenaura&opponent=p1&mergeLinked=1&grid=48&opp_race=Z");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(deps.opponents.identityClause).toHaveBeenCalledWith("u1", "p1", { mergeLinked: true });
    expect(deps.spatial.opponentProxies).toHaveBeenCalledWith(
      "u1", "Goldenaura", expect.objectContaining({ oppRace: "Z" }),
      { grid: 48, opponent: { "opponent.pulseId": "p1" } },
    );
  });

  test("no opponent means no identity lookup", async () => {
    const { app, deps } = harness();
    const res = await request(app).get("/v1/spatial/battle?map=Goldenaura");
    expect(res.status).toBe(200);
    expect(deps.opponents.identityClause).not.toHaveBeenCalled();
    expect(deps.spatial.battle.mock.calls[0][3]).toEqual({ grid: undefined, opponent: null });
  });

  test("an opponent outside the caller's history is a 404, and a malformed one a 400", async () => {
    const missing = harness({ clause: null });
    const notFound = await request(missing.app).get("/v1/spatial/battle?map=Goldenaura&opponent=stranger");
    expect(notFound.status).toBe(404);
    expect(missing.deps.spatial.battle).not.toHaveBeenCalled();
    const { app, deps } = harness();
    const bad = await request(app).get(`/v1/spatial/battle?map=Goldenaura&opponent=${"x".repeat(201)}`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_opponent");
    expect(deps.opponents.identityClause).not.toHaveBeenCalled();
  });

  test("a map is still required", async () => {
    const { app } = harness();
    const res = await request(app).get("/v1/spatial/battle?opponent=p1");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("map_required");
  });
});

describe("OpponentsService.identityClause", () => {
  const { OpponentsService } = require("../src/services/opponents");

  function service(doc) {
    const db = {
      opponents: { findOne: jest.fn().mockResolvedValue(doc) },
      opponentNotes: {},
      games: {},
    };
    return { svc: new OpponentsService(db, Buffer.alloc(32)), db };
  }

  test("one identity matches its pulse id or its character id, within the owner", async () => {
    const { svc, db } = service({ pulseId: "p1", pulseCharacterId: "c1" });
    expect(await svc.identityClause("u1", "p1")).toEqual({
      $or: [{ "opponent.pulseId": "p1" }, { "opponent.pulseCharacterId": "c1" }],
    });
    expect(db.opponents.findOne.mock.calls[0][0]).toEqual({ userId: "u1", pulseId: "p1" });
  });

  test("merged identities match every linked pulse id and character id", async () => {
    const { svc } = service({ pulseId: "p1", pulseCharacterId: "c1" });
    svc._resolveLinkedIdentities = jest.fn().mockResolvedValue({ pulseIds: ["p1", "p2"], characterIds: ["c1", "c2"] });
    expect(await svc.identityClause("u1", "p1", { mergeLinked: true })).toEqual({
      $or: [{ "opponent.pulseId": { $in: ["p1", "p2"] } }, { "opponent.pulseCharacterId": { $in: ["c1", "c2"] } }],
    });
  });

  test("an opponent the owner never played is null", async () => {
    const { svc } = service(null);
    expect(await svc.identityClause("u1", "nobody", { mergeLinked: true })).toBeNull();
  });
});
