// @ts-nocheck
"use strict";
const request = require("supertest");
jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
const { createHarness } = require("./helpers/reviewsHarness");
const { MAX_SAVE_BYTES, MAX_SLOTS, MAX_TAPE_CHUNK_CHARS, MAX_TAPE_CHUNKS, MAX_TAPE_BYTES } = require("../src/services/humdingers");

describe("Humdingers account saves, play totals, play sessions and run tapes", () => {
  let h; let now;
  beforeAll(async () => { h = await createHarness({ rollout: "off" }); for (const name of ["ann", "bob", "admin"]) await h.seedUser(name); });
  afterAll(async () => h.close());
  beforeEach(async () => {
    now = new Date("2026-11-27T12:00:00Z");
    h.services.humdingers.now = () => now;
    await Promise.all([h.db.humdingersSaves.deleteMany({}), h.db.humdingersPlayDays.deleteMany({}), h.db.humdingersPlayPlayers.deleteMany({}),
      h.db.humdingersPlaySessions.deleteMany({}), h.db.humdingersTapeChunks.deleteMany({})]);
  });
  const as = (name, req) => req.set("authorization", h.bearer(name));
  const save = (when, meta = {}, state = { flags: { w1_complete: false } }) =>
    JSON.stringify({ fmt: "humdingers-save", v: 3, meta: { when, playtime: 125, chapter: 2, world: "w1", ...meta }, state });
  const put = (name, slot, data) => as(name, request(h.app).put(`/v1/me/humdingers/saves/${slot}`)).send({ data });
  const play = (name, body) => as(name, request(h.app).post("/v1/me/humdingers/plays")).send(body);
  // Each chunk holds 9 characters and covers 100 ticks.
  const chunk = (seq, extra = {}) =>
    ({ seq, enc: "gzip-b64", data: `H4sIAAAA${seq}`, build: "w1-20261127", from: seq * 100, to: seq * 100 + 99, ...extra });
  const tape = (name, session, body) => as(name, request(h.app).post(`/v1/me/humdingers/tapes/${session}`)).send(body);
  const readTape = (userId, session) => as("admin", request(h.app).get(`/v1/admin/humdingers/tapes/${userId}/${session}`));

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
          { session: "visit-b-00001", startedAt: "2026-11-27T11:00:00.000Z", lastAt: "2026-11-27T11:00:00.000Z", activeSeconds: 60, maxChapter: 2,
            saved: true, tape: null },
          { session: "visit-a-00001", startedAt: "2026-11-27T10:00:00.000Z", lastAt: "2026-11-27T10:00:00.000Z", activeSeconds: 120, maxChapter: 1,
            saved: false, tape: null },
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

  test("tape chunks need a website account, a play session id and a valid chunk", async () => {
    await request(h.app).post("/v1/me/humdingers/tapes/visit-tape-0001").send(chunk(0)).expect(401);
    for (const session of ["short", "has%20space!", "x".repeat(65)]) {
      expect((await tape("ann", session, chunk(0)).expect(400)).body.error.code).toBe("bad_session");
    }
    const bad = [
      { seq: -1 }, { seq: 10_000 }, { seq: 1.5 }, { seq: "1" }, { enc: "gzip" }, { enc: undefined },
      { data: "not base64!" }, { data: "" }, { data: 42 }, { data: "A".repeat(MAX_TAPE_CHUNK_CHARS + 1) },
      { build: "" }, { build: "w1 build" }, { build: "b".repeat(41) },
      { from: -1 }, { to: 50_000_001 }, { from: 10, to: 9 }, { from: "0" },
      { final: "yes" }, { summary: ["won"] }, { summary: "won" },
    ];
    for (const extra of bad) {
      expect((await tape("ann", "visit-tape-0001", chunk(0, extra)).expect(400)).body.error.code).toBe("bad_tape_chunk");
    }
    expect((await tape("ann", "visit-tape-0001", [chunk(0)]).expect(400)).body.error.code).toBe("bad_tape_chunk");
    expect(await h.db.humdingersTapeChunks.countDocuments()).toBe(0);
    expect(await h.db.humdingersPlaySessions.countDocuments()).toBe(0);
    // A full-size base64 chunk fits the body limit; plain JSON chunks need no base64, and null means absent.
    await tape("ann", "visit-tape-0001", chunk(0, { data: "A".repeat(MAX_TAPE_CHUNK_CHARS) })).expect(204);
    await tape("ann", "visit-tape-0001", chunk(1, { enc: "json", data: "[[12,\"A\"]]", final: null, summary: null })).expect(204);
    expect(await h.db.humdingersTapeChunks.countDocuments({ userId: h.userId("ann") })).toBe(2);
  });

  test("a chunk is kept with the account and adds to its visit's tape totals", async () => {
    const res = await tape("ann", "visit-tape-0001", chunk(0)).expect(204);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const expiresAt = new Date("2027-02-25T12:00:00Z");
    expect(await h.db.humdingersTapeChunks.findOne({ userId: h.userId("ann") }, { projection: { _id: 0 } })).toEqual({
      userId: h.userId("ann"), session: "visit-tape-0001", seq: 0, enc: "gzip-b64", data: "H4sIAAAA0", bytes: 9, build: "w1-20261127",
      from: 0, to: 99, createdAt: now, expiresAt, _schemaVersion: 1,
    });
    // No play report has arrived yet: the tape starts the session row as recordPlay would.
    expect(await h.db.humdingersPlaySessions.findOne({ userId: h.userId("ann") }, { projection: { _id: 0 } })).toEqual({
      userId: h.userId("ann"), session: "visit-tape-0001", startedAt: now, lastAt: now, loads: 0, activeSeconds: 0, maxChapter: 0,
      saved: false, expiresAt, _schemaVersion: 1, tape: { build: "w1-20261127", chunks: 1, bytes: 9, ticks: 99, updatedAt: now },
    });
    now = new Date("2026-11-27T12:05:00Z");
    await play("ann", { type: "active", seconds: 300, chapter: 2, session: "visit-tape-0001" }).expect(204);
    const summary = { ticks: 4321, maps: 2.5, fights: "7", won: -5, lost: 1, ran: 0, overs: 0, levelups: 2, saves: 1, hints: 20_000_000,
      goal: "g".repeat(130), secret: "dropped" };
    await tape("ann", "visit-tape-0001", chunk(1, { enc: "json", data: "[[12,\"A\"]]", final: true, summary })).expect(204);
    const row = await h.db.humdingersPlaySessions.findOne({ userId: h.userId("ann"), session: "visit-tape-0001" });
    expect(row).toMatchObject({ startedAt: new Date("2026-11-27T12:00:00Z"), lastAt: now, loads: 0, activeSeconds: 300, maxChapter: 2 });
    expect(row.tape).toEqual({
      build: "w1-20261127", chunks: 2, bytes: 19, ticks: 199, final: true, updatedAt: now,
      summary: { ticks: 4321, won: 0, lost: 1, ran: 0, overs: 0, levelups: 2, saves: 1, hints: 10_000_000, goal: "g".repeat(120) },
    });
  });

  test("a retried chunk is stored once and counted once", async () => {
    await tape("ann", "visit-tape-0002", chunk(0)).expect(204);
    await tape("ann", "visit-tape-0002", chunk(0, { data: "RGlmZmVyZW50" })).expect(204);
    await Promise.all([tape("ann", "visit-tape-0002", chunk(1)).expect(204), tape("ann", "visit-tape-0002", chunk(1)).expect(204)]);
    const chunks = await h.db.humdingersTapeChunks.find({ userId: h.userId("ann") }).sort({ seq: 1 }).toArray();
    expect(chunks.map((row) => [row.seq, row.data])).toEqual([[0, "H4sIAAAA0"], [1, "H4sIAAAA1"]]);
    expect((await h.db.humdingersPlaySessions.findOne({ userId: h.userId("ann"), session: "visit-tape-0002" })).tape)
      .toMatchObject({ chunks: 2, bytes: 18, ticks: 199 });
    // a page-exit retry of a stored chunk still marks the tape final, counting nothing again
    await tape("ann", "visit-tape-0002", chunk(1, { final: true })).expect(204);
    expect((await h.db.humdingersPlaySessions.findOne({ userId: h.userId("ann"), session: "visit-tape-0002" })).tape)
      .toMatchObject({ chunks: 2, bytes: 18, ticks: 199, final: true });
  });

  test("refuses chunks past a visit's chunk and size caps", async () => {
    const seed = (session, totals) => h.db.humdingersPlaySessions.insertOne({
      userId: h.userId("ann"), session, startedAt: now, lastAt: now, loads: 1, activeSeconds: 0, maxChapter: 0, saved: false,
      expiresAt: new Date("2027-02-25T12:00:00Z"), tape: { build: "w1-20261127", ticks: 0, ...totals },
    });
    await seed("visit-full-0001", { chunks: MAX_TAPE_CHUNKS - 1, bytes: 0 });
    await tape("ann", "visit-full-0001", chunk(0)).expect(204);
    expect((await tape("ann", "visit-full-0001", chunk(1)).expect(413)).body.error.code).toBe("tape_full");
    await seed("visit-full-0002", { chunks: 3, bytes: MAX_TAPE_BYTES - 8 });
    expect((await tape("ann", "visit-full-0002", chunk(0, { data: "QUJDREVGR" })).expect(413)).body.error.code).toBe("tape_full");
    await tape("ann", "visit-full-0002", chunk(0, { data: "QUJDREVG" })).expect(204);
    expect((await tape("ann", "visit-full-0002", chunk(1, { data: "Q" })).expect(413)).body.error.code).toBe("tape_full");
    const rows = await h.db.humdingersPlaySessions.find({ userId: h.userId("ann") }, { projection: { _id: 0, session: 1, "tape.chunks": 1, "tape.bytes": 1 } })
      .sort({ session: 1 }).toArray();
    expect(rows).toEqual([
      { session: "visit-full-0001", tape: { chunks: MAX_TAPE_CHUNKS, bytes: 9 } },
      { session: "visit-full-0002", tape: { chunks: 4, bytes: MAX_TAPE_BYTES } },
    ]);
    expect(await h.db.humdingersTapeChunks.countDocuments({ userId: h.userId("ann") })).toBe(2);
  });

  test("admins read a visit's tape with its chunks in order; others cannot", async () => {
    for (const seq of [2, 0, 1]) {
      await tape("ann", "visit-read-0001", chunk(seq, seq === 2 ? { final: true, summary: { won: 3, goal: "Reach the lighthouse" } } : {})).expect(204);
    }
    await tape("bob", "visit-read-0001", chunk(0, { data: "Qm9i" })).expect(204);
    await request(h.app).get(`/v1/admin/humdingers/tapes/${h.userId("ann")}/visit-read-0001`).expect(401);
    await as("ann", request(h.app).get(`/v1/admin/humdingers/tapes/${h.userId("ann")}/visit-read-0001`)).expect(403);
    const res = await readTape(h.userId("ann"), "visit-read-0001").expect(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body).toEqual({ tape: {
      userId: h.userId("ann"), session: "visit-read-0001", build: "w1-20261127", ticks: 299, bytes: 27, final: true,
      summary: { won: 3, goal: "Reach the lighthouse" }, startedAt: "2026-11-27T12:00:00.000Z", lastAt: "2026-11-27T12:00:00.000Z",
      chunks: [0, 1, 2].map((seq) => ({ seq, enc: "gzip-b64", data: `H4sIAAAA${seq}`, from: seq * 100, to: seq * 100 + 99 })),
    } });
    expect((await readTape(h.userId("ann"), "visit-none-0001").expect(404)).body.error.code).toBe("not_found");
    expect((await readTape(h.userId("carl"), "visit-read-0001").expect(404)).body.error.code).toBe("not_found");
    expect((await readTape(h.userId("ann"), "short").expect(400)).body.error.code).toBe("bad_session");
    expect((await readTape("u".repeat(65), "visit-read-0001").expect(400)).body.error.code).toBe("bad_user");
    // Without its session row the tape still reads, with no times, end flag or summary.
    await h.db.humdingersPlaySessions.deleteOne({ userId: h.userId("ann"), session: "visit-read-0001" });
    expect((await readTape(h.userId("ann"), "visit-read-0001").expect(200)).body.tape)
      .toMatchObject({ final: false, summary: null, startedAt: null, lastAt: null, ticks: 299, bytes: 27 });
  });

  test("admin stats show each session's id and tape totals", async () => {
    await play("ann", { type: "load", session: "visit-plain-01" }).expect(204);
    now = new Date("2026-11-27T12:01:00Z");
    await tape("ann", "visit-taped-01", chunk(0)).expect(204);
    await tape("ann", "visit-taped-01", chunk(1, { final: true, summary: { fights: 2 } })).expect(204);
    const res = await as("admin", request(h.app).get("/v1/admin/humdingers/stats?days=7")).expect(200);
    expect(res.body.players[0]).toMatchObject({ userId: h.userId("ann"), sessions: 2 });
    expect(res.body.players[0].recent).toEqual([
      { session: "visit-taped-01", startedAt: "2026-11-27T12:01:00.000Z", lastAt: "2026-11-27T12:01:00.000Z", activeSeconds: 0, maxChapter: 0,
        saved: false, tape: { build: "w1-20261127", chunks: 2, bytes: 18, ticks: 199, final: true, summary: { fights: 2 } } },
      { session: "visit-plain-01", startedAt: "2026-11-27T12:00:00.000Z", lastAt: "2026-11-27T12:00:00.000Z", activeSeconds: 0, maxChapter: 0,
        saved: false, tape: null },
    ]);
  });

  // Erases ann's account, so it stays last.
  test("account export includes the saves, sessions and tapes, and erasure removes them", async () => {
    await put("ann", "0", save(1000)).expect(200);
    await play("ann", { type: "load", session: "visit-export-1" }).expect(204);
    for (const seq of [0, 1]) await tape("ann", "visit-export-1", chunk(seq)).expect(204);
    await tape("bob", "visit-export-1", chunk(0)).expect(204);
    expect((await as("ann", request(h.app).get("/v1/me/data-inventory")).expect(200)).body.removed)
      .toMatchObject({ humdingersSaves: 1, humdingersPlaySessions: 1, humdingersTapes: 2 });
    const exported = await h.services.gdpr.export(h.userId("ann"));
    expect(exported.data.humdingersSaves).toEqual([expect.objectContaining({ slot: "0", when: 1000, data: save(1000) })]);
    expect(exported.data.humdingersSaves[0]).not.toHaveProperty("_id");
    expect(exported.data.humdingersPlaySessions).toEqual([expect.objectContaining({ session: "visit-export-1", loads: 1 })]);
    expect(exported.data.humdingersPlaySessions[0]).not.toHaveProperty("_id");
    expect([...exported.data.humdingersTapes].sort((a, b) => a.seq - b.seq)).toEqual([0, 1].map((seq) => ({
      userId: h.userId("ann"), session: "visit-export-1", seq, enc: "gzip-b64", data: `H4sIAAAA${seq}`, bytes: 9, build: "w1-20261127",
      from: seq * 100, to: seq * 100 + 99, createdAt: now, expiresAt: new Date("2027-02-25T12:00:00Z"), _schemaVersion: 1,
    })));
    const counts = await h.services.gdpr.deleteAll(h.userId("ann"));
    expect(counts.humdingersSaves).toBe(1);
    expect(counts.humdingersPlaySessions).toBe(1);
    expect(counts.humdingersTapeChunks).toBe(2);
    expect(await h.db.humdingersSaves.countDocuments({ userId: h.userId("ann") })).toBe(0);
    expect(await h.db.humdingersPlaySessions.countDocuments({ userId: h.userId("ann") })).toBe(0);
    expect(await h.db.humdingersTapeChunks.countDocuments({ userId: h.userId("ann") })).toBe(0);
    expect(await h.db.humdingersTapeChunks.countDocuments({ userId: h.userId("bob") })).toBe(1);
  });
});
