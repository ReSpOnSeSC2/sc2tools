// @ts-nocheck
"use strict";

/**
 * Personal goals (services/playerGoals.js + routes/goals.js) against real
 * Mongo: the 8-active cap under concurrency, lazy progress per goal type
 * with minimum samples, local-week buckets across DST, the effective build
 * (check-ins count), notify-once claims, the rev-aware memo, window ends and
 * owner isolation over HTTP.
 */

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { NotificationsService } = require("../src/services/notifications");
const { PlayerGoalsService, MAX_ACTIVE } = require("../src/services/playerGoals");
const { buildGoalsRouter } = require("../src/routes/goals");

const OWNER = "goal-owner";
const OTHER = "goal-other";
const NY = "America/New_York";
// Wednesday 2026-11-11, 13:00 in New York (the week after the DST change).
const NOW = Date.parse("2026-11-11T18:00:00.000Z");

let mongo;
let db;
let notifications;
let svc;
let now;
let seq = 0;

function game(overrides = {}) {
  seq += 1;
  return {
    userId: OWNER, gameId: `g-${seq}`, date: new Date(NOW - 60 * 60_000), result: "Victory",
    myRace: "Protoss", opponent: { race: "Zerg", displayName: "Rival" }, map: "Alcyone LE",
    isLadderGame: true, matchFormat: "1v1", playerCount: 2, durationSec: 600,
    ...overrides,
  };
}

function goal(overrides = {}) {
  return {
    type: "games_played",
    params: { target: 3 },
    filters: { ranked: true },
    window: { recurrence: "weekly", startsOn: "2026-11-02", endsOn: "2026-11-29", tz: NY },
    ...overrides,
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
  db = await connect({ uri: mongo.getUri(), dbName: "player_goals_test" });
  notifications = new NotificationsService(db);
});

afterAll(async () => {
  await db?.close();
  await mongo?.stop();
});

beforeEach(async () => {
  now = NOW;
  await Promise.all([db.games.deleteMany({}), db.playerGoals.deleteMany({}), db.notifications.deleteMany({}), db.users.deleteMany({})]);
  await db.users.insertMany([{ userId: OWNER, clerkUserId: "clerk-goal-owner" }, { userId: OTHER, clerkUserId: "clerk-goal-other" }]);
  svc = new PlayerGoalsService(db, { notifications, now: () => now });
});

describe("goal cap and validation", () => {
  test("concurrent creates fill exactly the 8 active slots; the first 3 are pinned", async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => svc.create(OWNER, goal())));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(MAX_ACTIVE);
    for (const r of results.filter((x) => x.status === "rejected")) expect(r.reason).toMatchObject({ status: 409, code: "goal_limit" });
    const active = await db.playerGoals.find({ userId: OWNER, status: "active" }).toArray();
    expect(active.map((g) => g.slot).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(active.filter((g) => g.pinned)).toHaveLength(3);
    // A deleted goal frees its slot.
    await svc.remove(OWNER, active[0].id);
    await expect(svc.create(OWNER, goal())).resolves.toBeTruthy();
  });

  test.each([
    [{ type: "nope" }, "invalid_goal"],
    [{ type: "win_rate", params: { target: 55, minGames: 10 } }, "invalid_goal"],
    [{ type: "build_reps", params: { target: 5, build: { key: "pvz-2-gate", name: "PvZ - 2 Gate" } } }, "invalid_goal"],
    [{ type: "mmr_reach", params: { target: 4000 }, window: { recurrence: "daily", startsOn: "2026-11-01", endsOn: "2026-11-30", tz: NY } }, "invalid_goal_window"],
    [{ window: { recurrence: "once", startsOn: "2026-01-01", endsOn: "2027-06-01", tz: NY } }, "invalid_goal_window"],
    [{ window: { recurrence: "once", startsOn: "2026-11-01", endsOn: "2026-11-30", tz: "Mars/Olympus" } }, "invalid_timezone"],
    [{ window: { recurrence: "season", startsOn: "2026-10-01", endsOn: "2026-12-31", tz: NY } }, "invalid_goal_window"],
  ])("rejects %j", async (patch, code) => {
    await expect(svc.create(OWNER, goal(patch))).rejects.toMatchObject({ status: 400, code });
    expect(await db.playerGoals.countDocuments({})).toBe(0);
  });
});

describe("progress", () => {
  test("weekly games count local New York weeks and only ranked 1v1 games in the filter", async () => {
    await db.games.insertMany([
      // Sunday 23:30 EST: the previous local week.
      game({ date: new Date("2026-11-09T04:30:00.000Z") }),
      // Monday 00:30 EST: this week.
      game({ date: new Date("2026-11-09T05:30:00.000Z") }),
      game(),
      game({ isLadderGame: false }),
      game({ matchFormat: "team", playerCount: 4 }),
      game({ opponent: { race: "Terran" } }),
      game({ excluded: true }),
      game({ userId: OTHER }),
    ]);
    const list = await svc.create(OWNER, goal({ filters: { ranked: true, matchup: "PvZ" }, params: { target: 5 } }));
    const [view] = list.goals;
    expect(view.label).toBe("Play 5 ranked PvZ games each week");
    expect(view.progress).toMatchObject({ state: "active", value: 2, target: 5, fraction: 0.4,
      current: { key: "2026-11-09", startsAt: "2026-11-09T05:00:00.000Z", endsAt: "2026-11-16T05:00:00.000Z" } });
    // The window's first week (from Monday 2026-11-02) had one game, below target.
    expect(view.progress.buckets).toEqual({ total: 4, elapsed: 2, met: 0 });
  });

  test("a win rate stays a sample guard until minGames decided games", async () => {
    await db.games.insertMany([
      ...Array.from({ length: 10 }, () => game({ result: "Victory" })),
      ...Array.from({ length: 9 }, () => game({ result: "Defeat" })),
      game({ result: "Tie" }),
    ]);
    const body = goal({ type: "win_rate", params: { target: 55 }, window: { recurrence: "once", startsOn: "2026-11-01", endsOn: "2026-11-30", tz: NY } });
    const [view] = (await svc.create(OWNER, body)).goals;
    expect(view.params.minGames).toBe(20);
    expect(view.progress).toMatchObject({ phase: "sample", needed: 1, games: 19, value: null, met: false });
    await db.games.insertOne(game({ result: "Victory" }));
    svc.invalidateForUser(OWNER);
    // Met: a once goal completes and moves to the history.
    const list = await svc.list(OWNER);
    expect(list.goals).toHaveLength(0);
    expect(list.completed[0]).toMatchObject({ outcome: "met",
      progress: { state: "met", phase: "progress", needed: null, games: 20, value: 55, met: true } });
  });

  test("averages need their minimum sample; MMR reports no rated games, then progress from the window's first rating", async () => {
    await db.games.insertMany(Array.from({ length: 4 }, () => game({ spq: 85 })));
    const once = { recurrence: "once", startsOn: "2026-11-01", endsOn: "2026-11-30", tz: NY };
    await svc.create(OWNER, goal({ type: "sq_avg", params: { target: 80, minGames: 5 }, window: once }));
    const list = await svc.create(OWNER, goal({ type: "mmr_reach", params: { target: 4000 }, window: once }));
    const sq = list.goals.find((g) => g.type === "sq_avg");
    const mmr = list.goals.find((g) => g.type === "mmr_reach");
    expect(sq.progress).toMatchObject({ phase: "sample", needed: 1, games: 4, value: null });
    expect(mmr.progress).toMatchObject({ phase: "sample", noRatedGames: true, value: null, fraction: 0 });
    await db.games.insertMany([
      game({ date: new Date(NOW - 3 * 3600_000), myMmr: 3900 }),
      game({ date: new Date(NOW - 2 * 3600_000), myMmr: 3950 }),
    ]);
    svc.invalidateForUser(OWNER);
    const after = (await svc.list(OWNER)).goals.find((g) => g.type === "mmr_reach");
    expect(after.progress).toMatchObject({ value: 3950, first: 3900, peak: 3950, met: false, fraction: 0.5 });
  });

  test("build practice counts the effective build, including check-ins", async () => {
    const name = "PvZ - 2 Gate Expand";
    await db.games.insertMany([
      game({ myBuild: name }),
      game({ myBuild: name }),
      game({ myBuild: name, buildIntent: { status: "confirmed", applied: true, build: { key: "pvz-2-gate-expand", name }, detected: { name: "PvZ - Other", slug: null } } }),
      game({ myBuild: "PvZ - Other" }),
    ]);
    const [view] = (await svc.create(OWNER, goal({
      type: "build_reps",
      params: { target: 5, build: { key: "pvz-2-gate-expand", name } },
      filters: { ranked: true, matchup: "PvZ" },
    }))).goals;
    expect(view.label).toBe(`Play ${name} 5 times in PvZ each week`);
    expect(view.progress).toMatchObject({ value: 3, checkins: 1 });
  });
});

describe("notifications and settlement", () => {
  test("a met goal notifies exactly once wherever it is evaluated, and completes", async () => {
    await db.games.insertMany([game(), game(), game()]);
    await db.playerGoals.insertOne({ userId: OWNER, id: "g_once", type: "games_played", params: { target: 3 },
      filters: { matchup: null, map: null, ranked: true }, title: null, pinned: true, status: "active", slot: 0,
      window: { recurrence: "once", startsOn: "2026-11-01", endsOn: "2026-11-30", tz: NY,
        startsAt: new Date("2026-11-01T04:00:00.000Z"), endsAt: new Date("2026-12-01T05:00:00.000Z") },
      metNotifiedKey: null, createdAt: new Date(NOW - 86_400_000) });
    await Promise.all([svc.afterIngest(OWNER), svc.list(OWNER), new PlayerGoalsService(db, { notifications, now: () => now }).afterIngest(OWNER)]);
    await svc.afterIngest(OWNER);
    const rows = await db.notifications.find({ userId: OWNER }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "goal_met", title: "Goal reached: Play 3 ranked games", href: "/app/goals" });
    const stored = await db.playerGoals.findOne({ id: "g_once" });
    expect(stored).toMatchObject({ status: "completed", outcome: "met", metNotifiedKey: "once" });
    expect(stored.slot).toBeUndefined();
    const list = await svc.list(OWNER);
    expect(list.goals).toHaveLength(0);
    expect(list.completed[0]).toMatchObject({ id: "g_once", status: "completed", outcome: "met" });
  });

  test("a daily goal notifies once per local day", async () => {
    await svc.create(OWNER, goal({ params: { target: 1 }, window: { recurrence: "daily", startsOn: "2026-11-10", endsOn: "2026-11-20", tz: NY } }));
    await db.games.insertOne(game());
    await svc.afterIngest(OWNER);
    await svc.afterIngest(OWNER);
    expect(await db.notifications.countDocuments({ userId: OWNER, kind: "goal_met" })).toBe(1);
    now = NOW + 86_400_000;
    await db.games.insertOne(game({ date: new Date(now - 60_000) }));
    await svc.afterIngest(OWNER);
    expect(await db.notifications.countDocuments({ userId: OWNER, kind: "goal_met" })).toBe(2);
    expect((await svc.list(OWNER)).goals[0].status).toBe("active");
  });

  test("a muted kind sends nothing but the claim still holds", async () => {
    await db.users.updateOne({ userId: OWNER }, { $set: { "preferences.notifications": { muted: ["goal_met"] } } });
    await svc.create(OWNER, goal({ params: { target: 1 } }));
    await db.games.insertOne(game());
    await svc.afterIngest(OWNER);
    expect(await db.notifications.countDocuments({})).toBe(0);
    expect((await db.playerGoals.findOne({ userId: OWNER })).metNotifiedKey).toBe("2026-11-09");
  });

  test("a goal whose window ended completes as missed and frees its slot", async () => {
    await svc.create(OWNER, goal({ params: { target: 10 }, window: { recurrence: "once", startsOn: "2026-11-01", endsOn: "2026-11-12", tz: NY } }));
    await db.games.insertOne(game());
    now = Date.parse("2026-11-14T12:00:00.000Z");
    svc.invalidateForUser(OWNER);
    const list = await svc.list(OWNER);
    expect(list.goals).toHaveLength(0);
    expect(list.completed[0]).toMatchObject({ outcome: "missed", completedAt: "2026-11-13T05:00:00.000Z" });
    expect(list.completed[0].progress).toMatchObject({ value: 1, target: 10 });
    expect((await db.playerGoals.findOne({ userId: OWNER })).slot).toBeUndefined();
    expect(await db.notifications.countDocuments({})).toBe(0);
  });
});

describe("memo", () => {
  test("reads reuse one aggregation for 60 s until a game or goal write", async () => {
    await svc.create(OWNER, goal());
    const aggregate = jest.spyOn(db.games, "aggregate");
    await svc.list(OWNER);
    await svc.list(OWNER);
    expect(aggregate).toHaveBeenCalledTimes(0);
    svc.invalidateForUser(OWNER);
    await svc.list(OWNER);
    expect(aggregate).toHaveBeenCalledTimes(1);
    now += 61_000;
    await svc.list(OWNER);
    expect(aggregate).toHaveBeenCalledTimes(2);
    aggregate.mockRestore();
  });

  test("a player without active goals costs one indexed read per check", async () => {
    const aggregate = jest.spyOn(db.games, "aggregate");
    await svc.afterIngest(OWNER);
    expect(aggregate).not.toHaveBeenCalled();
    aggregate.mockRestore();
  });
});

describe("routes", () => {
  function app() {
    const server = express();
    server.use(express.json());
    server.use("/v1", buildGoalsRouter({
      goals: svc,
      auth: (req, res, next) => {
        const owner = req.get("x-owner");
        if (!owner) { res.sendStatus(401); return; }
        req.auth = { userId: owner };
        next();
      },
    }));
    return server;
  }

  test("auth, owner isolation, pin limit and delete", async () => {
    const server = app();
    await request(server).get("/v1/goals").expect(401);
    const created = await request(server).post("/v1/goals").set("x-owner", OWNER).send(goal()).expect(201);
    expect(created.headers["cache-control"]).toBe("private, no-store");
    const id = created.body.goals[0].id;
    expect(JSON.stringify(created.body)).not.toContain(OWNER);
    await request(server).put(`/v1/goals/${id}`).set("x-owner", OTHER).send({ pinned: false }).expect(404);
    await request(server).delete(`/v1/goals/${id}`).set("x-owner", OTHER).expect(404);
    expect((await request(server).get("/v1/goals").set("x-owner", OTHER)).body.goals).toEqual([]);
    for (let i = 0; i < 3; i += 1) await request(server).post("/v1/goals").set("x-owner", OWNER).send(goal()).expect(201);
    const fourth = (await request(server).get("/v1/goals").set("x-owner", OWNER)).body.goals.find((g) => !g.pinned);
    const pin = await request(server).put(`/v1/goals/${fourth.id}`).set("x-owner", OWNER).send({ pinned: true }).expect(409);
    expect(pin.body.error.code).toBe("pin_limit");
    const retarget = await request(server).put(`/v1/goals/${id}`).set("x-owner", OWNER).send({ params: { target: 7 }, title: "Grind" }).expect(200);
    expect(retarget.body.goals.find((g) => g.id === id)).toMatchObject({ label: "Grind", params: { target: 7 } });
    const removed = await request(server).delete(`/v1/goals/${id}`).set("x-owner", OWNER).expect(200);
    expect(removed.body.goals.map((g) => g.id)).not.toContain(id);
    await request(server).post("/v1/goals").set("x-owner", OWNER).send({ type: "nope" }).expect(400);
  });
});
