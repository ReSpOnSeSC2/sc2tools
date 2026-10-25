// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");

const { buildOpponentsRouter } = require("../src/routes/opponents");
const { CommunityService, K_ANONYMITY_THRESHOLD } = require("../src/services/community");

/**
 * The dossier links to the public community profile only when it
 * exists: GET /opponents/:pulseId carries ``communityAvailable``, which
 * the community service answers from the k-anonymity pre-check and
 * caches per process.
 */

function fakeDb({ contributors = 0, pulseCharacterId = null } = {}) {
  const calls = { distinct: 0, findOne: 0 };
  const users = Array.from({ length: contributors }, (_, i) => `user-${i}`);
  return {
    calls,
    db: {
      communityReports: { findOne: jest.fn(async () => null) },
      opponents: {
        findOne: jest.fn(async () => {
          calls.findOne += 1;
          return pulseCharacterId ? { pulseCharacterId } : null;
        }),
      },
      games: {
        distinct: jest.fn(async (field, filter) => {
          calls.distinct += 1;
          calls.lastFilter = filter;
          return [...users, "", null];
        }),
      },
    },
  };
}

describe("CommunityService.opponentProfileAvailable", () => {
  test("is true only at the k-anonymity floor", async () => {
    const below = new CommunityService(fakeDb({ contributors: K_ANONYMITY_THRESHOLD - 1 }).db);
    const at = new CommunityService(fakeDb({ contributors: K_ANONYMITY_THRESHOLD }).db);
    await expect(below.opponentProfileAvailable("1-S2-1-1")).resolves.toBe(false);
    await expect(at.opponentProfileAvailable("1-S2-1-1")).resolves.toBe(true);
  });

  test("checks the same cross-toon scope as the public aggregate", async () => {
    const { db, calls } = fakeDb({ contributors: 5, pulseCharacterId: "994428" });
    await new CommunityService(db).opponentProfileAvailable("1-S2-1-1");
    expect(calls.lastFilter).toEqual({
      excluded: { $ne: true },
      _deleted: { $ne: true },
      _deletionPending: { $ne: true },
      isResumedFromReplay: { $ne: true },
      $or: [
        { "opponent.pulseId": "1-S2-1-1" },
        { "opponent.pulseCharacterId": "994428" },
      ],
    });
  });

  test("caches the answer for an hour, then asks again", async () => {
    let now = 1_000_000;
    const { db, calls } = fakeDb({ contributors: 6 });
    const service = new CommunityService(db, { now: () => now });
    await service.opponentProfileAvailable("1-S2-1-1");
    await service.opponentProfileAvailable("1-S2-1-1");
    expect(calls.distinct).toBe(1);
    now += 59 * 60 * 1000;
    await service.opponentProfileAvailable("1-S2-1-1");
    expect(calls.distinct).toBe(1);
    now += 2 * 60 * 1000;
    await service.opponentProfileAvailable("1-S2-1-1");
    expect(calls.distinct).toBe(2);
  });

  test("keeps the cache bounded", async () => {
    const { db } = fakeDb({ contributors: 6 });
    const service = new CommunityService(db);
    for (let i = 0; i < 5005; i += 1) {
      await service.opponentProfileAvailable(`1-S2-1-${i}`);
    }
    expect(service.opponentAvailability.size).toBe(5000);
    // The oldest answers went first.
    expect(service.opponentAvailability.has("1-S2-1-0")).toBe(false);
    expect(service.opponentAvailability.has("1-S2-1-5004")).toBe(true);
  });
});

describe("GET /opponents/:pulseId communityAvailable", () => {
  function makeApp({ profile = { games: [], totals: { total: 0 } }, community } = {}) {
    const auth = (req, _res, next) => {
      req.auth = { userId: "dossier-owner" };
      next();
    };
    const app = express();
    app.use(buildOpponentsRouter({
      opponents: { get: jest.fn(async () => profile) },
      community,
      auth,
    }));
    return app;
  }

  test("reports whether the public profile exists", async () => {
    const opponentProfileAvailable = jest.fn(async () => true);
    const res = await request(makeApp({ community: { opponentProfileAvailable } })).get("/opponents/1-S2-1-1");
    expect(res.status).toBe(200);
    expect(res.body.communityAvailable).toBe(true);
    expect(res.body.totals).toEqual({ total: 0 });
    expect(opponentProfileAvailable).toHaveBeenCalledWith("1-S2-1-1");
  });

  test("hides the link when the check fails, without failing the dossier", async () => {
    const opponentProfileAvailable = jest.fn(async () => {
      throw new Error("mongo down");
    });
    const res = await request(makeApp({ community: { opponentProfileAvailable } })).get("/opponents/1-S2-1-1");
    expect(res.status).toBe(200);
    expect(res.body.communityAvailable).toBe(false);
  });

  test("is false when the community service isn't wired", async () => {
    const res = await request(makeApp()).get("/opponents/1-S2-1-1");
    expect(res.body.communityAvailable).toBe(false);
  });

  test("still 404s an opponent that isn't in your history", async () => {
    const res = await request(makeApp({
      profile: null,
      community: { opponentProfileAvailable: jest.fn(async () => true) },
    })).get("/opponents/1-S2-1-1");
    expect(res.status).toBe(404);
    expect(res.body.communityAvailable).toBeUndefined();
  });
});
