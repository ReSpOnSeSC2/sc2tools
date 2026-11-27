// @ts-nocheck
"use strict";
const request = require("supertest");
jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
const { createHarness } = require("./helpers/reviewsHarness");
const { MAX_SAVE_BYTES, MAX_SLOTS } = require("../src/services/humdingers");

describe("Humdingers account saves and play totals", () => {
  let h; let now;
  beforeAll(async () => { h = await createHarness({ rollout: "off" }); for (const name of ["ann", "bob", "admin"]) await h.seedUser(name); });
  afterAll(async () => h.close());
  beforeEach(async () => {
    now = new Date("2026-11-27T12:00:00Z");
    h.services.humdingers.now = () => now;
    await Promise.all([h.db.humdingersSaves.deleteMany({}), h.db.humdingersPlayDays.deleteMany({}), h.db.humdingersPlayPlayers.deleteMany({})]);
  });
  const as = (name, req) => req.set("authorization", h.bearer(name));
  const save = (when, meta = {}, state = { flags: { w1_complete: false } }) =>
    JSON.stringify({ fmt: "humdingers-save", v: 3, meta: { when, playtime: 125, chapter: 2, world: "w1", ...meta }, state });
  const put = (name, slot, data) => as(name, request(h.app).put(`/v1/me/humdingers/saves/${slot}`)).send({ data });
  const play = (name, body) => as(name, request(h.app).post("/v1/me/humdingers/plays")).send(body);

  test("saves need a website session and round-trip per account and slot", async () => {
    await request(h.app).get("/v1/me/humdingers/saves").expect(401);
    await request(h.app).put("/v1/me/humdingers/saves/0").send({ data: save(1000) }).expect(401);
    await put("ann", "0", save(1000)).expect(200);
    const listed = await as("ann", request(h.app).get("/v1/me/humdingers/saves")).expect(200);
    expect(listed.headers["cache-control"]).toBe("private, no-store");
    expect(listed.body.saves).toEqual([expect.objectContaining({ slot: "0", data: save(1000), when: 1000 })]);
    expect((await as("bob", request(h.app).get("/v1/me/humdingers/saves")).expect(200)).body.saves).toEqual([]);
    expect(await h.db.humdingersSaves.findOne({ userId: h.userId("ann"), slot: "0" })).toMatchObject({ playtime: 125, chapter: 2, world: "w1" });
  });

  test("the newest save wins and an older upload gets the stored copy back", async () => {
    await put("ann", "auto", save(2000)).expect(200);
    const stale = await put("ann", "auto", save(1500)).expect(409);
    expect(stale.body).toMatchObject({ error: { code: "newer_save" }, save: { slot: "auto", data: save(2000), when: 2000 } });
    await put("ann", "auto", save(2000)).expect(200);
    await put("ann", "auto", save(2500, { chapter: 3 })).expect(200);
    expect(await h.db.humdingersSaves.findOne({ userId: h.userId("ann"), slot: "auto" })).toMatchObject({ when: 2500, chapter: 3 });
    expect((await as("ann", request(h.app).delete("/v1/me/humdingers/saves/auto")).expect(200)).body).toEqual({ deleted: true });
    expect(await h.db.humdingersSaves.countDocuments({ userId: h.userId("ann") })).toBe(0);
  });

  test("rejects bad slots, foreign or oversized data and too many slots", async () => {
    expect((await put("ann", "Bad-Slot", save(1)).expect(400)).body.error.code).toBe("bad_slot");
    for (const data of ["{}", "not json", save(0), JSON.stringify({ fmt: "other", meta: { when: 1 }, state: {} })]) {
      expect((await put("ann", "0", data).expect(400)).body.error.code).toBe("bad_save");
    }
    const oversized = save(1, {}, { pad: "x".repeat(MAX_SAVE_BYTES) });
    expect((await put("ann", "0", oversized).expect(413)).body.error.code).toBe("save_too_large");
    for (let slot = 0; slot < MAX_SLOTS; slot += 1) await put("ann", String(slot), save(10)).expect(200);
    expect((await put("ann", "extra", save(10)).expect(400)).body.error.code).toBe("too_many_slots");
    await put("ann", "0", save(11)).expect(200);
  });

  test("counts loads, unique players, active time and savers per day without user IDs", async () => {
    await play("ann", { type: "load", chapter: 1 }).expect(204);
    await play("ann", { type: "load" }).expect(204);
    await play("bob", { type: "load", saved: true, chapter: 3 }).expect(204);
    await play("bob", { type: "active", seconds: 300, longPlay: true, saved: true }).expect(204);
    expect(await h.db.humdingersPlayDays.findOne({ _id: "2026-11-27" }))
      .toMatchObject({ loads: 3, uniquePlayers: 2, activeSeconds: 300, longPlays: 1, savers: 1, maxChapter: 3 });
    const keys = JSON.stringify(await h.db.humdingersPlayPlayers.find().toArray());
    expect(keys).not.toContain(h.userId("ann"));
    expect(keys).not.toContain(h.userId("bob"));
    now = new Date("2026-11-28T00:00:01Z");
    await play("ann", { type: "load" }).expect(204);
    expect(await h.db.humdingersPlayDays.findOne({ _id: "2026-11-28" })).toMatchObject({ loads: 1, uniquePlayers: 1 });
    for (const bad of [{ type: "other" }, { type: "active", seconds: 0 }, { type: "active", seconds: 601 }, { type: "load", chapter: 100 }]) {
      expect((await play("ann", bad).expect(400)).body.error.code).toBe("bad_play");
    }
  });

  test("admin totals cover the chosen range and stay admin-only", async () => {
    await play("ann", { type: "load", chapter: 2 }).expect(204);
    await play("ann", { type: "active", seconds: 120, longPlay: true }).expect(204);
    await as("ann", request(h.app).get("/v1/admin/humdingers/stats")).expect(403);
    const res = await as("admin", request(h.app).get("/v1/admin/humdingers/stats?days=7")).expect(200);
    expect(res.body.days).toBe(7);
    expect(res.body.daily).toHaveLength(7);
    expect(res.body.daily[0]).toEqual({ day: "2026-11-27", loads: 1, players: 1, activeSeconds: 120, longPlays: 1, savers: 0, maxChapter: 2 });
    expect(res.body.daily[6]).toMatchObject({ day: "2026-11-21", loads: 0 });
    expect(res.body.totals).toEqual({ loads: 1, playerDays: 1, activeSeconds: 120, longPlays: 1, savers: 0, maxChapter: 2 });
    expect((await as("admin", request(h.app).get("/v1/admin/humdingers/stats")).expect(200)).body.days).toBe(30);
    await as("admin", request(h.app).get("/v1/admin/humdingers/stats?days=12")).expect(400);
  });

  test("account export includes the saves and erasure removes them", async () => {
    await put("ann", "0", save(1000)).expect(200);
    const exported = await h.services.gdpr.export(h.userId("ann"));
    expect(exported.data.humdingersSaves).toEqual([expect.objectContaining({ slot: "0", when: 1000, data: save(1000) })]);
    expect(exported.data.humdingersSaves[0]).not.toHaveProperty("_id");
    const counts = await h.services.gdpr.deleteAll(h.userId("ann"));
    expect(counts.humdingersSaves).toBe(1);
    expect(await h.db.humdingersSaves.countDocuments({ userId: h.userId("ann") })).toBe(0);
  });
});
