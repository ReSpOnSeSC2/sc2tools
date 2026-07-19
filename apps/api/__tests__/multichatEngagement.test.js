// @ts-nocheck
"use strict";

/**
 * MultichatEngagementService — XP/levels, Crystal Ball predictions,
 * clip-moment detection, and the idempotent multi-source ingest that
 * everything sits on. Real in-memory Mongo; socket broadcasts
 * captured through a fake io.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const {
  MultichatEngagementService,
  levelForXp,
  xpForLevel,
  parsePick,
  RANK_NAMES,
  PREDICTION_LOCK_MS,
  PREDICTION_STALE_MS,
} = require("../src/services/multichatEngagement");

let mongo;
let db;
/** @type {Array<{room: string, event: string, msg: any}>} */
let emitted;
let nowMs;
let svc;

const TOKEN = "tok_engage";

const msg = (id, user, text, extra = {}) => ({
  platform: "twitch",
  id,
  user,
  text,
  atMs: nowMs,
  ...extra,
});

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "engagement_test" });
});

afterAll(async () => {
  if (db) await db.close();
  if (mongo) await mongo.stop();
});

beforeEach(async () => {
  emitted = [];
  nowMs = 1_700_000_000_000;
  const io = {
    to: (room) => ({
      emit: (event, m) => emitted.push({ room, event, msg: m }),
    }),
  };
  svc = new MultichatEngagementService(db, { io, now: () => nowMs });
  await db.multichatEngagementEvents.deleteMany({});
  await db.multichatViewers.deleteMany({});
  await db.multichatPredictions.deleteMany({});
  await db.multichatClipMoments.deleteMany({});
});

describe("levels", () => {
  test("curve is monotonic and rank names cover every level", () => {
    expect(levelForXp(0)).toBe(0);
    expect(levelForXp(xpForLevel(1))).toBe(1);
    expect(levelForXp(xpForLevel(5) + 1)).toBe(5);
    expect(RANK_NAMES.length).toBe(10);
  });

  test("parsePick accepts the command family only", () => {
    expect(parsePick("!win")).toBe("win");
    expect(parsePick(" !LOSS ")).toBe("loss");
    expect(parsePick("!w")).toBe("win");
    expect(parsePick("winning this one")).toBeNull();
  });
});

describe("ingest", () => {
  test("credits XP once even when two sources report the same batch", async () => {
    const batch = [msg("m1", "Viewer", "hello"), msg("m2", "Viewer", "gg")];
    const first = await svc.ingest(TOKEN, batch);
    const second = await svc.ingest(TOKEN, batch); // second Browser Source
    expect(first.accepted).toBe(2);
    expect(second.accepted).toBe(0);
    const viewer = await db.multichatViewers.findOne({
      token: TOKEN,
      userKey: "twitch:viewer",
    });
    expect(viewer.xp).toBe(4);
    expect(viewer.messages).toBe(2);
  });

  test("platform events pay kind-weighted XP and level-ups broadcast", async () => {
    await svc.ingest(TOKEN, [
      msg("e1", "Whale", "", { kind: "raid" }), // 100 XP → level 1 (needs 100)
    ]);
    const viewer = await db.multichatViewers.findOne({
      token: TOKEN,
      userKey: "twitch:whale",
    });
    expect(viewer.xp).toBe(100);
    const levelUp = emitted.find((e) => e.msg.type === "level-up");
    expect(levelUp).toBeTruthy();
    expect(levelUp.room).toBe(`overlay:${TOKEN}`);
    expect(levelUp.msg.rank).toBe("Zealot");
  });

  test("junk entries drop; caps apply", async () => {
    const out = await svc.ingest(TOKEN, [
      { platform: "myspace", id: "x", user: "a" },
      { platform: "twitch", id: "", user: "a" },
      "garbage",
      msg("ok1", "Real", "fine"),
    ]);
    expect(out.accepted).toBe(1);
  });
});

describe("Crystal Ball predictions", () => {
  test("open → picks recorded only while open → settle scores oracles", async () => {
    await svc.openPrediction([TOKEN], { gameKey: "g1", opponent: "Serral" });
    expect(emitted.some((e) => e.msg.type === "prediction-open")).toBe(true);

    // Picks: two win, one loss; a later pick replaces the earlier one.
    await svc.ingest(TOKEN, [
      msg("p1", "Alice", "!win"),
      msg("p2", "Bob", "!loss"),
      msg("p3", "Cara", "!win"),
      msg("p4", "Bob", "!win"), // Bob changes his mind
    ]);
    const open = await db.multichatPredictions.findOne({ token: TOKEN, gameKey: "g1" });
    expect(Object.keys(open.picks)).toHaveLength(3);
    expect(open.picks["twitch:bob"].pick).toBe("win");

    await svc.settlePrediction([TOKEN], { gameKey: "g1", result: "win" });
    const settled = emitted.find((e) => e.msg.type === "prediction-settled");
    expect(settled.msg.result).toBe("win");
    expect(settled.msg.tally).toEqual({ win: 3, loss: 0, total: 3 });
    expect(settled.msg.correctCount).toBe(3);

    const alice = await db.multichatViewers.findOne({ token: TOKEN, userKey: "twitch:alice" });
    expect(alice.oracle).toMatchObject({ score: 10, correct: 1, total: 1 });

    // Picks after settlement are ignored (no open window).
    await svc.ingest(TOKEN, [msg("p5", "Late", "!win")]);
    const doc = await db.multichatPredictions.findOne({ token: TOKEN, gameKey: "g1" });
    expect(Object.keys(doc.picks)).toHaveLength(3);
  });

  test("voting locks ~90s after open: late picks are ignored", async () => {
    await svc.openPrediction([TOKEN], { gameKey: "g-lock", opponent: "Serral" });
    const open = emitted.find((e) => e.msg.type === "prediction-open");
    expect(open.msg.locksAtMs).toBe(nowMs + PREDICTION_LOCK_MS);

    // In-window pick lands.
    await svc.ingest(TOKEN, [msg("l1", "Alice", "!win")]);
    // Past the lock: a fresh pick must be dropped.
    nowMs += PREDICTION_LOCK_MS + 1_000;
    await svc.ingest(TOKEN, [msg("l2", "Late", "!loss")]);
    const doc = await db.multichatPredictions.findOne({
      token: TOKEN,
      gameKey: "g-lock",
    });
    expect(Object.keys(doc.picks)).toEqual(["twitch:alice"]);

    // Settlement still works after the lock — the locked window is
    // closed to votes, not to scoring.
    await svc.settlePrediction([TOKEN], { gameKey: "g-lock", result: "win" });
    const alice = await db.multichatViewers.findOne({
      token: TOKEN,
      userKey: "twitch:alice",
    });
    expect(alice.oracle.score).toBe(10);
  });

  test("summary carries locksAtMs and the chat-majority oracle recap", async () => {
    // Two settled calls: majority right once (win call → win), wrong
    // once (win call → loss); a tie window is excluded from the recap.
    await svc.openPrediction([TOKEN], { gameKey: "s1", opponent: "A" });
    await svc.ingest(TOKEN, [msg("r1", "Ann", "!win"), msg("r2", "Ben", "!win")]);
    await svc.settlePrediction([TOKEN], { gameKey: "s1", result: "win" });
    nowMs += 1_000;
    await svc.openPrediction([TOKEN], { gameKey: "s2", opponent: "B" });
    await svc.ingest(TOKEN, [msg("r3", "Ann", "!win"), msg("r4", "Ben", "!loss")]);
    await svc.settlePrediction([TOKEN], { gameKey: "s2", result: "loss" });
    nowMs += 1_000;
    await svc.openPrediction([TOKEN], { gameKey: "s3", opponent: "Cure" });
    await svc.ingest(TOKEN, [msg("r5", "Ann", "!win")]);
    await svc.settlePrediction([TOKEN], { gameKey: "s3", result: "loss" });
    nowMs += 1_000;
    await svc.openPrediction([TOKEN], { gameKey: "s4", opponent: "Open" });

    const out = await svc.summary(TOKEN);
    expect(out.prediction.gameKey).toBe("s4");
    expect(out.prediction.locksAtMs).toBe(nowMs + PREDICTION_LOCK_MS);
    // s2 was a tie → excluded; s1 right, s3 wrong → 1 of 2.
    expect(out.oracleRecap.calls).toBe(2);
    expect(out.oracleRecap.majorityRight).toBe(1);
    expect(out.oracleRecap.last).toMatchObject({
      opponent: "Cure",
      result: "loss",
      majority: "win",
      wasRight: false,
      pct: 100,
    });
  });

  test("legacy windows without locksAtMs lock off their open time", async () => {
    // A window written by a pre-lock deploy has no locksAtMs — it
    // must still stop accepting votes and report a lock time, or the
    // CALL IT prompt would sit on stream forever.
    await db.multichatPredictions.insertOne({
      token: TOKEN,
      gameKey: "legacy",
      opponent: "Old",
      openedAt: new Date(nowMs - PREDICTION_LOCK_MS - 5_000),
      settled: false,
      picks: {},
    });
    await svc.ingest(TOKEN, [msg("z1", "Zoe", "!win")]);
    const doc = await db.multichatPredictions.findOne({ token: TOKEN, gameKey: "legacy" });
    expect(Object.keys(doc.picks)).toHaveLength(0);
    const out = await svc.summary(TOKEN);
    expect(out.prediction.locksAtMs).toBe(nowMs - 5_000);
  });

  test("an abandoned open window goes stale and leaves the summary", async () => {
    await db.multichatPredictions.insertOne({
      token: TOKEN,
      gameKey: "ghost",
      opponent: "NoShow",
      openedAt: new Date(nowMs - PREDICTION_STALE_MS - 60_000),
      settled: false,
      picks: {},
    });
    const out = await svc.summary(TOKEN);
    expect(out.prediction).toBeNull();
  });

  test("settle falls back to the newest open window on gameKey drift", async () => {
    await svc.openPrediction([TOKEN], { gameKey: "env-key", opponent: "X" });
    await svc.ingest(TOKEN, [msg("q1", "Dana", "!loss")]);
    await svc.settlePrediction([TOKEN], { gameKey: "replay-key", result: "loss" });
    const doc = await db.multichatPredictions.findOne({ token: TOKEN, gameKey: "env-key" });
    expect(doc.settled).toBe(true);
    const dana = await db.multichatViewers.findOne({ token: TOKEN, userKey: "twitch:dana" });
    expect(dana.oracle.score).toBe(10);
  });

  test("openPrediction is idempotent per gameKey (1 Hz agent posts)", async () => {
    await svc.openPrediction([TOKEN], { gameKey: "g2", opponent: "X" });
    await svc.openPrediction([TOKEN], { gameKey: "g2", opponent: "X" });
    const opens = emitted.filter((e) => e.msg.type === "prediction-open");
    expect(opens).toHaveLength(1);
    expect(
      await db.multichatPredictions.countDocuments({ token: TOKEN, gameKey: "g2" }),
    ).toBe(1);
  });
});

describe("clip moments", () => {
  test("a chat spike over the trailing baseline records one moment with cooldown", async () => {
    // Trailing quiet baseline: 1 msg per 10s bucket.
    for (let i = 0; i < 5; i += 1) {
      await svc.ingest(TOKEN, [msg(`base${i}`, "U", "hi")]);
      nowMs += 10_000;
    }
    // Spike: 12 messages inside one bucket.
    const spike = Array.from({ length: 12 }, (_, i) =>
      msg(`spike${i}`, `V${i}`, "POGGERS"),
    );
    await svc.ingest(TOKEN, spike);
    const moments = await db.multichatClipMoments.find({ token: TOKEN }).toArray();
    expect(moments).toHaveLength(1);
    expect(moments[0].kind).toBe("chat-spike");
    expect(moments[0].sampleLines.length).toBeGreaterThan(0);
    expect(emitted.some((e) => e.msg.type === "clip-moment")).toBe(true);

    // Another burst inside the cooldown does NOT double-record.
    await svc.ingest(
      TOKEN,
      Array.from({ length: 12 }, (_, i) => msg(`again${i}`, `W${i}`, "wow")),
    );
    expect(await db.multichatClipMoments.countDocuments({ token: TOKEN })).toBe(1);
  });

  test("recordMoment stores game events for the dock list", async () => {
    await svc.recordMoment(TOKEN, {
      kind: "game-event",
      reason: "Victory vs Serral — +34 MMR swing",
      gameKey: "g9",
    });
    const summary = await svc.summary(TOKEN);
    expect(summary.clipMoments[0]).toMatchObject({
      kind: "game-event",
      gameKey: "g9",
    });
  });
});

describe("viewerStats (!rank)", () => {
  test("returns level math for a known viewer and a friendly zero state", async () => {
    await svc.ingest(TOKEN, [
      msg("v1", "Chatter", "hello"),
      msg("v2", "Chatter", "", { kind: "raid" }),
    ]);
    const stats = await svc.viewerStats(TOKEN, "twitch", "CHATTER");
    expect(stats.found).toBe(true);
    expect(stats.xp).toBe(102);
    expect(stats.level).toBe(1);
    expect(stats.nextLevel).toBe(2);
    expect(stats.xpToNext).toBe(xpForLevel(2) - 102);
    const ghost = await svc.viewerStats(TOKEN, "twitch", "nobody");
    expect(ghost.found).toBe(false);
    expect(ghost.xp).toBe(0);
    expect(ghost.level).toBe(0);
  });
});

describe("summary", () => {
  test("wall ranks by XP with SC2 rank names", async () => {
    await svc.ingest(TOKEN, [
      msg("s1", "Grinder", "a"),
      msg("s2", "Grinder", "b"),
      msg("s3", "Casual", "c"),
      msg("s4", "Whale", "", { kind: "raid" }),
    ]);
    const out = await svc.summary(TOKEN);
    expect(out.wall[0]).toMatchObject({ user: "Whale", xp: 100, rank: "Zealot" });
    expect(out.wall[1]).toMatchObject({ user: "Grinder", xp: 4, rank: "Probe" });
    expect(out.prediction).toBeNull();
  });
});
