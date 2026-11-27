// @ts-nocheck
"use strict";
const request = require("supertest");
jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
const { createHarness } = require("./helpers/reviewsHarness");
const { MAX_SAVE_BYTES, MAX_SLOTS } = require("../src/services/humdingers");

describe("Humdingers account saves, play totals and play sessions", () => {
  let h; let now;
  beforeAll(async () => { h = await createHarness({ rollout: "off" }); for (const name of ["ann", "bob", "admin"]) await h.seedUser(name); });
  afterAll(async () => h.close());
  beforeEach(async () => {
    now = new Date("2026-11-27T12:00:00Z");
    h.services.humdingers.now = () => now;
    await Promise.all([h.db.humdingersSaves.deleteMany({}), h.db.humdingersPlayDays.deleteMany({}), h.db.humdingersPlayPlayers.deleteMany({}),
      h.db.humdingersPlaySessions.deleteMany({})]);
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

  test("keeps one session per visit with the account, for 90 days", async () => {
    await play("ann", { type: "load", chapter: 1, session: "visit-one-0001" }).expect(204);
    now = new Date("2026-11-27T12:05:00Z");
    await play("ann", { type: "active", seconds: 300, longPlay: true, saved: true, chapter: 2, session: "visit-one-0001" }).expect(204);
    now = new Date("2026-11-27T12:06:00Z");
    await play("ann", { type: "active", seconds: 40, chapter: 1, session: "visit-one-0001" }).expect(204);
    await play("bob", { type: "load", session: "visit-one-0001" }).expect(204);
    // A page opened before sessions existed sends no id: its reports share one row a day.
    await play("ann", { type: "active", seconds: 20 }).expect(204);
    await play("ann", { type: "active", seconds: 30 }).expect(204);
    const ann = await h.db.humdingersPlaySessions.find({ userId: h.userId("ann") }, { projection: { _id: 0, _schemaVersion: 0 } }).sort({ session: 1 }).toArray();
    expect(ann).toEqual([
      { userId: h.userId("ann"), session: "day-2026-11-27", startedAt: new Date("2026-11-27T12:06:00Z"), lastAt: new Date("2026-11-27T12:06:00Z"),
        loads: 0, activeSeconds: 50, maxChapter: 0, saved: false, expiresAt: new Date("2027-02-25T12:06:00Z") },
      { userId: h.userId("ann"), session: "visit-one-0001", startedAt: new Date("2026-11-27T12:00:00Z"), lastAt: new Date("2026-11-27T12:06:00Z"),
        loads: 1, activeSeconds: 340, maxChapter: 2, saved: true, expiresAt: new Date("2027-02-25T12:00:00Z") },
    ]);
    expect(await h.db.humdingersPlaySessions.countDocuments({ userId: h.userId("bob") })).toBe(1);
    expect(await h.db.humdingersPlayDays.findOne({ _id: "2026-11-27" })).toMatchObject({ loads: 2, uniquePlayers: 2, activeSeconds: 390 });
    for (const session of ["short", "has space!", 42, "x".repeat(65)]) {
      expect((await play("ann", { type: "load", session }).expect(400)).body.error.code).toBe("bad_play");
    }
  });

  test("admin stats name the accounts that played, with their sessions and saves", async () => {
    await h.seedUser("ann", { email: "ann@example.com", displayName: "AnnPlays", battleTag: "Ann#1234" });
    await h.seedUser("bob", { email: "bob@example.com", battleTags: ["Bobby#42"] });
    // Bob saved before sessions were recorded: his save still lists him.
    now = new Date("2026-11-26T09:00:00Z");
    await put("bob", "0", save(1000, { playtime: 4000, chapter: 3 })).expect(200);
    // Ann's session ten days ago falls outside a 7-day range.
    now = new Date("2026-11-17T08:00:00Z");
    await play("ann", { type: "load", session: "old-visit-001" }).expect(204);
    await play("ann", { type: "active", seconds: 500, session: "old-visit-001" }).expect(204);
    now = new Date("2026-11-27T10:00:00Z");
    await play("ann", { type: "load", chapter: 1, session: "visit-a-00001" }).expect(204);
    await play("ann", { type: "active", seconds: 120, chapter: 1, session: "visit-a-00001" }).expect(204);
    now = new Date("2026-11-27T11:00:00Z");
    await play("ann", { type: "load", chapter: 2, session: "visit-b-00001" }).expect(204);
    await play("ann", { type: "active", seconds: 60, chapter: 2, saved: true, session: "visit-b-00001" }).expect(204);
    now = new Date("2026-11-27T12:00:00Z");
    await as("ann", request(h.app).get("/v1/admin/humdingers/stats?days=7")).expect(403);
    const res = await as("admin", request(h.app).get("/v1/admin/humdingers/stats?days=7")).expect(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body.playersTruncated).toBe(false);
    expect(res.body.players).toEqual([
      {
        userId: h.userId("ann"), displayName: "AnnPlays", battleTag: "Ann#1234", email: "ann@example.com",
        sessions: 2, activeSeconds: 180, lastAt: "2026-11-27T11:00:00.000Z", maxChapter: 2, save: null,
        recent: [
          { startedAt: "2026-11-27T11:00:00.000Z", lastAt: "2026-11-27T11:00:00.000Z", activeSeconds: 60, maxChapter: 2, saved: true },
          { startedAt: "2026-11-27T10:00:00.000Z", lastAt: "2026-11-27T10:00:00.000Z", activeSeconds: 120, maxChapter: 1, saved: false },
        ],
      },
      {
        userId: h.userId("bob"), displayName: null, battleTag: "Bobby#42", email: "bob@example.com",
        sessions: 0, activeSeconds: 0, lastAt: null, maxChapter: 0,
        save: { slots: 1, playtime: 4000, chapter: 3, savedAt: "2026-11-26T09:00:00.000Z" }, recent: [],
      },
    ]);
    const month = await as("admin", request(h.app).get("/v1/admin/humdingers/stats?days=30")).expect(200);
    expect(month.body.players[0]).toMatchObject({ userId: h.userId("ann"), sessions: 3, activeSeconds: 680 });
    expect(month.body.players[0].recent.map((row) => row.startedAt)).toEqual(["2026-11-27T11:00:00.000Z", "2026-11-27T10:00:00.000Z", "2026-11-17T08:00:00.000Z"]);
  });

  test("account export includes the saves and sessions, and erasure removes them", async () => {
    await put("ann", "0", save(1000)).expect(200);
    await play("ann", { type: "load", session: "visit-export-1" }).expect(204);
    const exported = await h.services.gdpr.export(h.userId("ann"));
    expect(exported.data.humdingersSaves).toEqual([expect.objectContaining({ slot: "0", when: 1000, data: save(1000) })]);
    expect(exported.data.humdingersSaves[0]).not.toHaveProperty("_id");
    expect(exported.data.humdingersPlaySessions).toEqual([expect.objectContaining({ session: "visit-export-1", loads: 1 })]);
    expect(exported.data.humdingersPlaySessions[0]).not.toHaveProperty("_id");
    const counts = await h.services.gdpr.deleteAll(h.userId("ann"));
    expect(counts.humdingersSaves).toBe(1);
    expect(counts.humdingersPlaySessions).toBe(1);
    expect(await h.db.humdingersSaves.countDocuments({ userId: h.userId("ann") })).toBe(0);
    expect(await h.db.humdingersPlaySessions.countDocuments({ userId: h.userId("ann") })).toBe(0);
  });
});
