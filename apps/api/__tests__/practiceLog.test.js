// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { GhostConfigService } = require("../src/services/ghostConfig");
const { PracticeLogService, SUMMARY_SAMPLE, REQUEST_GRADE_LIMIT } = require("../src/services/practiceLog");
const { targetHash } = require("../src/services/practiceGrade");

const step = (t, name) => ({ supply: null, t, name });
const GATE = { v: 1, name: "Gate core", steps: [step(18, "Pylon"), step(40, "Gateway"), step(90, "CyberneticsCore")] };
const STARGATE = { v: 1, name: "Stargate", steps: [step(18, "Pylon"), step(40, "Gateway"), step(120, "Stargate")] };
const ON_TIME = ["[0:18] Pylon", "[0:40] Gateway", "[1:30] Cybernetics Core"];
const LATE_CORE = ["[0:18] Pylon", "[0:41] Gateway", "[2:10] Cybernetics Core"];
const ARMED = new Date("2026-11-01T10:00:00Z");
const NOW = new Date("2026-11-05T10:00:00Z");

let mongo, db, ghost, practice, details;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "practice_log" });
});
afterAll(async () => { await db?.close(); await mongo?.stop(); });
beforeEach(async () => {
  await db.users.deleteMany({});
  await db.games.deleteMany({});
  await db.users.insertOne({ userId: "u1", preferences: { ghost: { v: 2, slots: { PvZ: GATE } }, ghostArmedAt: { PvZ: { hash: targetHash(GATE), at: ARMED } } } });
  details = { findMany: jest.fn(async (_userId, ids) => new Map(ids.map((id) => [id, { buildLog: ON_TIME }]))) };
  ghost = new GhostConfigService({ db });
  practice = new PracticeLogService(db, { gameDetails: details, now: () => NOW });
});

const game = (gameId, date, extra = {}) => ({ gameId, date, myRace: "Protoss", opponent: { race: "Zerg" }, buildLog: ON_TIME, ...extra });
const insert = (rows) => db.games.insertMany(rows.map((row) => ({ userId: "u1", result: "Victory", map: "Goldenaura", ...row })));
const ingest = async (row) => {
  await insert([{ gameId: row.gameId, date: new Date(row.date) }]);
  return practice.recordIngested("u1", row, await practice.ingestContext("u1"));
};

describe("ingest-time practice grading", () => {
  test("a game played after its matchup's target was armed is graded once and never regraded", async () => {
    const record = await ingest(game("g1", "2026-11-02T00:00:00Z"));
    expect(record).toMatchObject({ grade: "S", matchup: "PvZ", targetHash: targetHash(GATE), via: "ingest", gradedAt: NOW });
    // A re-upload with a different build log changes nothing.
    const again = await practice.recordIngested("u1", game("g1", "2026-11-02T00:00:00Z", { buildLog: LATE_CORE }), await practice.ingestContext("u1"));
    expect(again).toBeNull();
    expect((await db.games.findOne({ gameId: "g1" })).practice).toMatchObject({ grade: "S", targetName: "Gate core" });
    // After re-arming, a later game is graded against the new build, under its own hash.
    await ghost.patch("u1", { matchup: "PvZ", target: STARGATE });
    expect(await ingest(game("g3", "2099-01-01T00:00:00Z"))).toMatchObject({ targetHash: targetHash(STARGATE), targetName: "Stargate" });
    expect((await db.games.findOne({ gameId: "g1" })).practice.targetHash).toBe(targetHash(GATE));
  });

  test("games before the arm time, other matchups, Random and the target's own source game are not graded", async () => {
    expect(await ingest(game("before", "2026-10-31T00:00:00Z"))).toBeNull();
    expect(await ingest(game("pvt", "2026-11-02T00:00:00Z", { opponent: { race: "Terran" } }))).toBeNull();
    expect(await ingest(game("random", "2026-11-02T00:00:00Z", { opponent: { race: "Random" } }))).toBeNull();
    await db.users.updateOne({ userId: "u1" }, { $set: { "preferences.ghost.slots.PvZ": { ...GATE, sourceGameId: "source" } } });
    expect(await ingest(game("source", "2026-11-02T00:00:00Z"))).toBeNull();
    expect(await db.games.countDocuments({ practice: { $exists: true } })).toBe(0);
  });

  test("a slot armed before arm times were recorded grades only a game from the last day", async () => {
    await db.users.updateOne({ userId: "u1" }, { $unset: { "preferences.ghostArmedAt": "" } });
    expect(await ingest(game("resynced", "2026-11-03T00:00:00Z"))).toBeNull();
    expect(await ingest(game("live", "2026-11-05T09:00:00Z"))).toMatchObject({ grade: "S" });
  });

  test("a game without a build log counts as ungraded until an upload brings one", async () => {
    expect(await ingest(game("g2", "2026-11-02T00:00:00Z", { buildLog: undefined }))).toMatchObject({ status: "no_build_log" });
    const healed = await practice.recordIngested("u1", game("g2", "2026-11-02T00:00:00Z"), await practice.ingestContext("u1"));
    expect(healed).toMatchObject({ grade: "S" });
  });

  test("nothing armed reads one owner row and grades nothing", async () => {
    await db.users.updateOne({ userId: "u1" }, { $unset: { "preferences.ghost": "" } });
    expect(await practice.ingestContext("u1")).toBeNull();
    expect(await practice.recordIngested("u1", game("g", NOW.toISOString()), null)).toBeNull();
  });

});

describe("arm stamps on the synced Ghost slots", () => {
  test("arming stamps the slot, keeps the stamp for the same build and drops it when cleared", async () => {
    await db.users.updateOne({ userId: "u1" }, { $unset: { "preferences.ghostArmedAt": "" } });
    await ghost.patch("u1", { matchup: "PvT", target: STARGATE });
    let row = await db.users.findOne({ userId: "u1" });
    expect(row.preferences.ghostArmedAt.PvT).toEqual({ hash: targetHash(STARGATE), at: expect.any(Date) });
    // The untouched legacy PvZ slot gains no invented arm time.
    expect(row.preferences.ghostArmedAt.PvZ).toBeUndefined();
    const first = row.preferences.ghostArmedAt.PvT.at;
    await ghost.replace("u1", { v: 2, slots: { PvT: STARGATE, PvZ: STARGATE } });
    row = await db.users.findOne({ userId: "u1" });
    expect(row.preferences.ghostArmedAt.PvT.at).toEqual(first);
    expect(row.preferences.ghostArmedAt.PvZ.hash).toBe(targetHash(STARGATE));
    await ghost.patch("u1", { matchup: "PvT", target: null });
    row = await db.users.findOne({ userId: "u1" });
    expect(row.preferences.ghostArmedAt.PvT).toBeUndefined();
    // The synced transport never carries the stamps.
    expect(await ghost.get("u1")).not.toHaveProperty("ghostArmedAt");
  });

});

const record = (hash, name, extra) => ({ v: 1, targetHash: hash, targetName: name, matchup: "PvZ", via: "ingest", gradedAt: NOW, ...extra });
const graded = (grade, extra = {}) => ({ grade, matched: 3, total: 3, avgDrift: 2, maxDrift: 4, firstDivergence: null, worstSteps: [], drifts: "0,1,4", ...extra });
const gate = targetHash(GATE);
/** Four games against the armed Gate core (one without a build log), one against an older target, a hidden one and a PvT one. */
const seedPracticeRows = () => insert([
  { gameId: "a", date: new Date("2026-11-04T00:00:00Z"), practice: record(gate, "Gate core", graded("S")) },
  { gameId: "b", date: new Date("2026-11-03T00:00:00Z"), practice: record(gate, "Gate core", graded("C", { matched: 2, drifts: "0,40,x", firstDivergence: { i: 1, name: "Gateway", expectedT: 40, actualT: 80 } })) },
  { gameId: "c", date: new Date("2026-11-02T00:00:00Z"), practice: record(gate, "Gate core", graded("D", { matched: 1, drifts: "2,x,x", firstDivergence: { i: 1, name: "Gateway", expectedT: 40, actualT: null } })) },
  { gameId: "d", date: new Date("2026-11-02T01:00:00Z"), practice: record(gate, "Gate core", { status: "no_build_log" }) },
  { gameId: "old", date: new Date("2026-10-01T00:00:00Z"), practice: record("0123456789abcdef", "Old opener", graded("B")) },
  { gameId: "hidden", excluded: true, date: new Date("2026-11-04T05:00:00Z"), practice: record(gate, "Gate core", graded("D")) },
  { gameId: "pvt", date: new Date("2026-11-04T06:00:00Z"), practice: { ...record(gate, "Gate core", graded("A")), matchup: "PvT" } },
]);

describe("practice summary", () => {
  beforeEach(seedPracticeRows);

  test("the armed target's progress groups its own games only", async () => {
    const out = await practice.summary("u1", { matchup: "PvZ" });
    expect(out.target).toMatchObject({ hash: gate, name: "Gate core", current: true, armedAt: ARMED.toISOString() });
    expect(out.sample).toEqual({ graded: 3, ungraded: 1, limit: SUMMARY_SAMPLE, capped: false });
    expect(out.grades).toEqual({ S: 1, A: 0, B: 0, C: 1, D: 1 });
    expect(out.history.map((row) => row.gameId)).toEqual(["a", "b", "c"]);
    expect(out.divergence).toEqual([{ i: 1, name: "Gateway", games: 2, cut: 1 }]);
    expect(out.steps).toEqual([
      { i: 0, name: "Pylon", t: 18, games: 3, hit: 3, avgDrift: 0.7 },
      { i: 1, name: "Gateway", t: 40, games: 3, hit: 2, avgDrift: 20.5 },
      { i: 2, name: "CyberneticsCore", t: 90, games: 3, hit: 1, avgDrift: 4 },
    ]);
    expect(out.targets).toEqual([
      { hash: gate, name: "Gate core", games: 4, lastPlayed: "2026-11-04T00:00:00.000Z", current: true },
      { hash: "0123456789abcdef", name: "Old opener", games: 1, lastPlayed: "2026-10-01T00:00:00.000Z", current: false },
    ]);
  });

  test("an earlier target is summarised by its hash, without the step breakdown", async () => {
    const out = await practice.summary("u1", { matchup: "PvZ", targetHash: "0123456789abcdef" });
    expect(out.target).toEqual({ hash: "0123456789abcdef", name: "Old opener", current: false, armedAt: null, steps: null });
    expect(out.grades.B).toBe(1);
    expect(out.steps).toBeNull();
  });

  test("summary reads are one owner row and one bounded indexed range", async () => {
    const find = jest.spyOn(db.games, "find");
    await practice.summary("u1", { matchup: "PvZ" });
    expect(find).toHaveBeenCalledTimes(1);
    const plan = await db.games.find(find.mock.calls[0][0]).sort({ date: -1 }).limit(SUMMARY_SAMPLE + 1).explain();
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain("practice_log");
    find.mockRestore();
  });

});

describe("practice games", () => {
  beforeEach(seedPracticeRows);

  test("graded games page newest first and never include hidden games", async () => {
    const first = await practice.games("u1", { matchup: "PvZ", targetHash: gate, limit: "2" });
    expect(first.items.map((row) => row.gameId)).toEqual(["a", "b"]);
    expect(first.items[1].practice).toMatchObject({ grade: "C", status: "graded", firstDivergence: { i: 1 } });
    const second = await practice.games("u1", { matchup: "PvZ", targetHash: gate, limit: "2", cursor: first.nextCursor });
    expect(second.items.map((row) => row.gameId)).toEqual(["d", "c"]);
    expect(second.items[0].practice).toMatchObject({ status: "no_build_log", grade: null });
    expect(second.nextCursor).toBeNull();
    await expect(practice.games("u1", { matchup: "PvZ", cursor: "nope" })).rejects.toMatchObject({ status: 400 });
    await expect(practice.summary("u1", { matchup: "PvR" })).rejects.toMatchObject({ status: 400 });
  });

  test("one game's stored record is the owner's only", async () => {
    expect(await practice.game("u1", "b")).toMatchObject({ grade: "C" });
    expect(await practice.game("u2", "b")).toBeNull();
    expect(await practice.game("u1", "hidden")).toBeNull();
  });
});

describe("grading the last games on request", () => {
  test("hydrates at most twenty and skips graded ones", async () => {
    const rows = Array.from({ length: REQUEST_GRADE_LIMIT + 5 }, (_, i) => ({ gameId: `r${i}`, myRace: "Protoss", opponent: { race: i % 2 ? "Zerg" : "Z" }, date: new Date(Date.UTC(2026, 9, 1 + i)) }));
    rows.push({ gameId: "graded", myRace: "Protoss", opponent: { race: "Zerg" }, date: new Date("2026-11-30T00:00:00Z"), practice: { v: 1, targetHash: "x", grade: "D" } });
    rows.push({ gameId: "pvt", myRace: "Protoss", opponent: { race: "Terran" }, date: new Date("2026-11-29T00:00:00Z") });
    await insert(rows);
    const out = await practice.gradeRecent("u1", { matchup: "PvZ" });
    expect(out).toEqual({ matchup: "PvZ", considered: REQUEST_GRADE_LIMIT, graded: REQUEST_GRADE_LIMIT });
    expect(details.findMany).toHaveBeenCalledTimes(1);
    expect(details.findMany.mock.calls[0][1]).toHaveLength(REQUEST_GRADE_LIMIT);
    expect(await db.games.countDocuments({ "practice.via": "request" })).toBe(REQUEST_GRADE_LIMIT);
    expect((await db.games.findOne({ gameId: "graded" })).practice.grade).toBe("D");
    expect((await db.games.findOne({ gameId: "r0" })).practice).toBeUndefined();
    await expect(practice.gradeRecent("u1", { matchup: "TvZ" })).rejects.toMatchObject({ status: 409 });
  });
});
