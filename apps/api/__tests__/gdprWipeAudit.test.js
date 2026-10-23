// @ts-nocheck
"use strict";

const request = require("supertest");
const { startHarness, userIdForClerk } = require("./helpers/browserIngestHarness");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async () => ({ sub: "clerk_wipe_admin" })),
}));

describe("history wipe restore audit", () => {
  let h;
  let userId;
  let info;

  beforeAll(async () => {
    h = await startHarness("gdpr_wipe_audit", { adminUserIds: ["clerk_wipe_admin"] });
    await request(h.app).get("/v1/me").set("authorization", "Bearer admin");
    userId = await userIdForClerk(h.db, "clerk_wipe_admin");
    info = jest.spyOn(h.services.gdpr.logger, "info");
  });

  afterAll(async () => {
    if (info) info.mockRestore();
    if (h) await h.stop();
  });

  test("records inclusive/exclusive bounds and preserves games outside them", async () => {
    await h.db.games.insertMany([1, 2, 3].map((day) => ({
      userId,
      gameId: `game-${day}`,
      date: new Date(`2026-10-0${day}T00:00:00Z`),
    })));
    const since = "2026-10-02T00:00:00.000Z";
    const until = "2026-10-03T00:00:00.000Z";
    const res = await request(h.app).post("/v1/me/games/wipe")
      .set("authorization", "Bearer admin").send({ since, until });
    expect(res.status).toBe(200);
    expect(res.body.counts.games).toBe(1);
    expect(await h.db.games.distinct("gameId", { userId })).toEqual(["game-1", "game-3"]);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      userId, scope: "range", since, until,
    }), "gdpr_games_wiped");
  });

  test("admin wipes record an explicit all-history scope through the same service", async () => {
    info.mockClear();
    const res = await request(h.app).post(`/v1/admin/users/${userId}/wipe-games`)
      .set("authorization", "Bearer admin");
    expect(res.status).toBe(202);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      userId, scope: "all", since: null, until: null,
    }), "gdpr_games_wiped");
    expect(info.mock.calls.filter(([, event]) => event === "gdpr_games_wiped")).toHaveLength(1);
  });
});
