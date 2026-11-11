// @ts-nocheck
"use strict";

/**
 * Stream Dock live tools: server-timed polls, manual clip-moment flags and
 * the paged clip-moment log. Real in-memory Mongo behind the real multichat
 * router; the clock is injected wherever the service reads it.
 */

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { UsersService } = require("../src/services/users");
const { OverlayTokensService } = require("../src/services/overlayTokens");
const { buildMultichatRouter } = require("../src/routes/multichat");
const { TikTokChatRelay } = require("../src/services/tiktokChatRelay");
const {
  MultichatStudioService,
  sanitizePoll,
  pollForRead,
  preparePollUpdate,
  POLL_DURATIONS_SEC,
} = require("../src/services/multichatStudio");
const {
  MultichatEngagementService,
  MANUAL_MOMENT_COOLDOWN_MS,
} = require("../src/services/multichatEngagement");

const T0 = 1_700_000_000_000;

describe("poll timing (pure)", () => {
  test("only the 30/60/120/300-second timers survive sanitizing", () => {
    expect(POLL_DURATIONS_SEC).toEqual([30, 60, 120, 300]);
    for (const durationSec of POLL_DURATIONS_SEC) {
      expect(sanitizePoll({ question: "Q", options: ["a", "b"], durationSec }).durationSec).toBe(durationSec);
    }
    for (const durationSec of [0, 1, 45, 90, 301, 3600, -30, "60", null, "x", Infinity]) {
      const poll = sanitizePoll({ question: "Q", options: ["a", "b"], durationSec });
      if (durationSec === "60") expect(poll.durationSec).toBe(60);
      else expect(poll.durationSec).toBeUndefined();
    }
  });

  test("a new poll is stamped by the server and ignores client timing", () => {
    const opened = preparePollUpdate(
      { question: "Q", options: ["a", "b"], status: "open", durationSec: 60, startedAtMs: 5, openedAtMs: 1, endsAtMs: 2, closedAtMs: 3 },
      null,
      T0,
    );
    expect(opened).toMatchObject({ startedAtMs: T0, openedAtMs: T0, endsAtMs: T0 + 60_000, durationSec: 60, status: "open" });
    expect(opened.closedAtMs).toBeUndefined();
    const untimed = preparePollUpdate({ question: "Q", options: ["a", "b"] }, null, T0);
    expect(untimed.endsAtMs).toBeUndefined();
    expect(untimed.durationSec).toBeUndefined();
  });

  test("an expired open poll reads as closed at its deadline without rewriting it", () => {
    const stored = { question: "Q", options: ["a", "b"], status: "open", startedAtMs: T0, openedAtMs: T0, durationSec: 30, endsAtMs: T0 + 30_000 };
    expect(pollForRead(stored, T0 + 29_999).status).toBe("open");
    expect(pollForRead(stored, T0 + 30_000)).toMatchObject({ status: "closed", closedAtMs: T0 + 30_000 });
    expect(stored.status).toBe("open");
    expect(pollForRead({ ...stored, endsAtMs: undefined }, T0 + 10 ** 9).status).toBe("open");
  });

  test("closing is idempotent, final and keeps the server's timing", () => {
    const stored = preparePollUpdate({ question: "Q", options: ["a", "b"], durationSec: 120 }, null, T0);
    const echo = { ...stored, endsAtMs: T0 + 999_999, question: "Edited" };
    const closed = preparePollUpdate({ ...echo, status: "closed" }, stored, T0 + 10_000);
    expect(closed).toMatchObject({ status: "closed", closedAtMs: T0 + 10_000, endsAtMs: T0 + 120_000, question: "Q" });
    expect(preparePollUpdate({ ...echo, status: "closed" }, closed, T0 + 20_000)).toEqual(closed);
    expect(preparePollUpdate({ ...echo, status: "open" }, closed, T0 + 20_000)).toEqual(closed);
    expect(preparePollUpdate({ ...echo, status: "open" }, stored, T0 + 20_000)).toEqual(stored);
  });

  test("a close from a clock up to two seconds ahead still closes at the deadline", () => {
    const stored = preparePollUpdate({ question: "Q", options: ["a", "b"], durationSec: 30 }, null, T0);
    expect(preparePollUpdate({ ...stored, status: "closed" }, stored, T0 + 28_500).closedAtMs).toBe(T0 + 30_000);
    expect(preparePollUpdate({ ...stored, status: "closed" }, stored, T0 + 20_000).closedAtMs).toBe(T0 + 20_000);
  });

  test("a stale close for an older poll leaves the current poll alone", () => {
    const older = preparePollUpdate({ question: "Old", options: ["a", "b"] }, null, T0);
    const current = preparePollUpdate({ question: "New", options: ["c", "d"], durationSec: 60 }, older, T0 + 5_000);
    expect(preparePollUpdate({ ...older, status: "closed" }, current, T0 + 6_000)).toEqual(current);
    expect(preparePollUpdate({ ...older, status: "closed" }, null, T0 + 6_000)).toBeNull();
    expect(preparePollUpdate(null, current, T0 + 6_000)).toBeNull();
  });
});

let mongo;
let db;
let app;
let token;
let otherToken;
let nowMs;
let emitted;
let engagement;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "multichat_dock_tools_test" });
  const users = new UsersService(db, {});
  const overlayTokens = new OverlayTokensService(db);
  const uid = (await users.ensureFromClerk("user_dock_tools")).userId;
  token = (await overlayTokens.create(uid, "dock")).token;
  otherToken = (await overlayTokens.create(uid, "second")).token;
  const io = { to: (room) => ({ emit: (event, msg) => emitted.push({ room, event, msg }) }) };
  engagement = new MultichatEngagementService(db, { io, now: () => nowMs });
  const studio = new MultichatStudioService(db, { io, now: () => nowMs });
  app = express();
  app.use(express.json());
  app.use("/v1", buildMultichatRouter({
    overlayTokens,
    users,
    tiktokRelay: new TikTokChatRelay({ connectionFactory: async () => ({ on() {}, connect: async () => ({}), disconnect() {} }) }),
    studio,
    engagement,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  }));
});

afterAll(async () => {
  if (db) await db.close();
  if (mongo) await mongo.stop();
});

beforeEach(async () => {
  nowMs = T0;
  emitted = [];
  // Each test starts with a fresh per-token cooldown.
  engagement._lastManualAt.clear();
  await db.multichatClipMoments.deleteMany({});
});

test("Flag moment needs a valid overlay token", async () => {
  const res = await request(app).post("/v1/multichat/not-a-token/moment").send({});
  expect(res.status).toBe(401);
  expect(res.body.error.code).toBe("invalid_overlay_token");
  expect(await db.multichatClipMoments.countDocuments({})).toBe(0);
});

test("records a manual moment with the default reason and broadcasts it", async () => {
  const res = await request(app).post(`/v1/multichat/${token}/moment`).send({});
  expect(res.status).toBe(201);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.body.moment).toEqual({ atMs: T0, kind: "manual", reason: "Flagged from Dock", sampleLines: [] });
  const stored = await db.multichatClipMoments.findOne({ token });
  expect(stored).toMatchObject({ kind: "manual", reason: "Flagged from Dock" });
  const event = emitted.find((e) => e.msg.type === "clip-moment");
  expect(event.room).toBe(`overlay:${token}`);
  expect(event.msg.moment).toEqual(res.body.moment);
  expect(event.msg.moment.token).toBeUndefined();
});

test("keeps an optional trimmed note and rejects long or multi-line notes", async () => {
  const ok = await request(app).post(`/v1/multichat/${token}/moment`).send({ note: "  Huge baneling hit  " });
  expect(ok.status).toBe(201);
  expect(ok.body.moment.reason).toBe("Huge baneling hit");
  nowMs += MANUAL_MOMENT_COOLDOWN_MS;
  expect((await request(app).post(`/v1/multichat/${token}/moment`).send({ note: "x".repeat(81) })).status).toBe(400);
  expect((await request(app).post(`/v1/multichat/${token}/moment`).send({ note: "one\ntwo" })).status).toBe(400);
  expect((await request(app).post(`/v1/multichat/${token}/moment`).send({ note: 42 })).status).toBe(400);
  const exact = await request(app).post(`/v1/multichat/${token}/moment`).send({ note: "y".repeat(80) });
  expect(exact.status).toBe(201);
  expect(exact.body.moment.reason).toBe("y".repeat(80));
});

test("allows one flag per token every five seconds", async () => {
  expect((await request(app).post(`/v1/multichat/${token}/moment`).send({})).status).toBe(201);
  nowMs += MANUAL_MOMENT_COOLDOWN_MS - 1;
  const soon = await request(app).post(`/v1/multichat/${token}/moment`).send({});
  expect(soon.status).toBe(429);
  expect(soon.body.error).toEqual({ code: "too_soon", message: "Too soon" });
  expect(soon.headers["retry-after"]).toBe("1");
  // The cooldown is per token.
  expect((await request(app).post(`/v1/multichat/${otherToken}/moment`).send({})).status).toBe(201);
  nowMs += 1;
  expect((await request(app).post(`/v1/multichat/${token}/moment`).send({})).status).toBe(201);
  expect(await db.multichatClipMoments.countDocuments({ token })).toBe(2);
});

test("pages the clip log newest first with before and limit", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ token, atMs: T0 + i * 1000, atDate: new Date(), kind: "chat-spike", reason: `m${i}`, sampleLines: [] }));
  await db.multichatClipMoments.insertMany([...rows, { token: otherToken, atMs: T0 + 9_000, atDate: new Date(), kind: "manual", reason: "other", sampleLines: [] }]);
  const first = await request(app).get(`/v1/multichat/${token}/moments?limit=2`);
  expect(first.status).toBe(200);
  expect(first.body.moments.map((m) => m.reason)).toEqual(["m4", "m3"]);
  expect(first.body.hasMore).toBe(true);
  expect(first.body.moments[0].token).toBeUndefined();
  const second = await request(app).get(`/v1/multichat/${token}/moments?limit=2&before=${T0 + 3000}`);
  expect(second.body.moments.map((m) => m.reason)).toEqual(["m2", "m1"]);
  const last = await request(app).get(`/v1/multichat/${token}/moments?limit=2&before=${T0 + 1000}`);
  expect(last.body).toEqual({ moments: [expect.objectContaining({ reason: "m0" })], hasMore: false });
  expect((await request(app).get(`/v1/multichat/${token}/moments?limit=101`)).status).toBe(400);
  expect((await request(app).get(`/v1/multichat/${token}/moments?before=soon`)).status).toBe(400);
  expect((await request(app).get(`/v1/multichat/not-a-token/moments`)).status).toBe(401);
});

test("a timed poll is stamped on open, reported closed after its deadline and closes idempotently", async () => {
  const opened = await request(app).post(`/v1/multichat/${token}/studio`).send({
    poll: { question: "Win or lose this game?", options: ["Win", "Lose"], status: "open", durationSec: 30, endsAtMs: T0 + 1 },
  });
  expect(opened.status).toBe(200);
  expect(opened.body.poll).toMatchObject({ status: "open", startedAtMs: T0, openedAtMs: T0, endsAtMs: T0 + 30_000, durationSec: 30 });

  nowMs = T0 + 30_001;
  const read = await request(app).get(`/v1/multichat/${token}/studio`);
  expect(read.body.poll).toMatchObject({ status: "closed", closedAtMs: T0 + 30_000 });

  const close = { poll: { ...opened.body.poll, status: "closed" } };
  const first = await request(app).post(`/v1/multichat/${token}/studio`).send(close);
  const second = await request(app).post(`/v1/multichat/${token}/studio`).send(close);
  expect(first.body.poll).toMatchObject({ status: "closed", closedAtMs: T0 + 30_000 });
  expect(second.body.poll).toEqual(first.body.poll);

  const cleared = await request(app).post(`/v1/multichat/${token}/studio`).send({ poll: null });
  expect(cleared.body.poll).toBeNull();
});
