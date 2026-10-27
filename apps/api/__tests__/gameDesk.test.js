// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { GameDeskService } = require("../src/services/gameDesk");
const { GamesService } = require("../src/services/games");
const { UsersService } = require("../src/services/users");
const { MultichatStudioService } = require("../src/services/multichatStudio");
const { MultichatEngagementService } = require("../src/services/multichatEngagement");
const { PlayerChannelsService } = require("../src/services/playerChannels");
const { OpponentChannelsCache } = require("../src/services/opponentChannels");
const { buildMultichatRouter } = require("../src/routes/multichat");
const { OverlayTokensService } = require("../src/services/overlayTokens");
const { SessionPolicyService } = require("../src/services/sessionPolicy");
const { OwnerRevisions } = require("../src/util/gameVisibility");
let mongo, db, svc, engagement, studio, games, live, verified, app, directory, channels, events, bot;
const TOKEN = "desk-token", OWNER = "desk-owner";
beforeAll(async () => { mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "game_desk" }); });
afterAll(async () => { await db?.close(); await mongo?.stop(); });
beforeEach(async () => {
  for (const collection of [db.users, db.games, db.multichatPredictions, db.multichatViewers, db.multichatStudio, db.playerChannels, db.overlayTokens]) await collection.deleteMany({});
  await db.users.insertOne({ userId: OWNER }); events = [];
  const io = { to: room => ({ emit: (event, payload) => events.push({ room, event, payload }) }) };
  engagement = new MultichatEngagementService(db, { io }); studio = new MultichatStudioService(db, { io });
  games = new GamesService(db, { users: new UsersService(db) });
  directory = new PlayerChannelsService(db, { seeds: [], fetchImpl: jest.fn(() => { throw new Error("No network"); }) });
  channels = new OpponentChannelsCache(directory); bot = { queueShoutout: jest.fn(() => false) };
  live = { type: "liveGameState", gameKey: "game-one", phase: "match_ended", opponent: { toonHandle: "1-S2-1-123" } }; verified = null;
  const tokens = { resolve: async token => token === TOKEN ? { userId: OWNER } : null, list: async () => [{ token: TOKEN }, { token: "revoked", revokedAt: new Date() }, { token: "rotating", rotationPending: true }] };
  svc = new GameDeskService({ users: db.users, studio, engagement, games, broker: { latest: () => live, latestOverlayLive: () => verified }, channels, tokens, bot, io });
  app = express(); app.use(express.json()); app.use(buildMultichatRouter({ overlayTokens: tokens, users: new UsersService(db), studio, engagement, gameDesk: svc }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: { code: error.code || "unknown" } }));
});
const post = body => request(app).post(`/multichat/${TOKEN}/studio`).send(body);
async function round(key = "game-one") {
  await engagement.openPrediction([TOKEN], { gameKey: key, opponent: "Opponent" });
  await db.multichatPredictions.updateOne({ token: TOKEN, gameKey: key }, { $set: { picks: { alice: { user: "Alice", platform: "twitch", pick: "win" } } } });
}
test("owner token required and action payloads reject unknown/unbounded fields", async () => {
  expect((await request(app).post("/multichat/foreign/studio").send({ action: "sessionReset" })).status).toBe(401);
  for (const body of [{ action: "unknown" }, { action: "gamePause", paused: "true" }, { action: "sessionReset", userId: "foreign" }, { action: "predictionCancel", gameKey: "x".repeat(121) }]) expect((await post(body)).status).toBe(400);
});
test.each(["match_loading", "match_started", "match_in_progress", "idle", "menu"])("manual resolve rejects %s", async phase => {
  await round(); live.phase = phase;
  expect((await post({ action: "predictionResolve", gameKey: live.gameKey, result: "win" })).status).toBe(409);
  expect((await db.multichatPredictions.findOne({ token: TOKEN })).settled).toBe(false);
});
test("manual resolve rejects replay, mismatched key, verified result and malformed result", async () => {
  await round(); live.isReplay = true;
  expect((await post({ action: "predictionResolve", gameKey: live.gameKey, result: "win" })).status).toBe(409);
  live.isReplay = false;
  expect((await post({ action: "predictionResolve", gameKey: "other", result: "win" })).status).toBe(409);
  verified = { gameKey: live.gameKey, result: "win" };
  expect((await post({ action: "predictionResolve", gameKey: live.gameKey, result: "loss" })).status).toBe(409);
  verified = null;
  expect((await post({ action: "predictionResolve", gameKey: live.gameKey, result: "draw" })).status).toBe(400);
});
test("a bounded observed end remains resolvable in menu, without any live opponent", async () => {
  await round(); live = { type: "liveGameState", phase: "menu", lastEndedGame: { gameKey: "game-one", endedAt: Date.now() } };
  expect((await post({ action: "predictionResolve", gameKey: "game-one", result: "win" })).status).toBe(200);
});
test("expired observed ends and a new active game cannot resolve the old round", async () => {
  await round(); live = { type: "liveGameState", phase: "menu", lastEndedGame: { gameKey: "game-one", endedAt: Date.now() - 31 * 60_000 } };
  expect((await post({ action: "predictionResolve", gameKey: "game-one", result: "win" })).status).toBe(409);
  live = { type: "liveGameState", phase: "match_started", gameKey: "game-two", lastEndedGame: { gameKey: "game-one", endedAt: Date.now() } };
  expect((await post({ action: "predictionResolve", gameKey: "game-one", result: "win" })).status).toBe(409);
});
test("manual reveal is terminal, awards no points and never enters recap accuracy", async () => {
  await round(); expect((await post({ action: "predictionResolve", gameKey: live.gameKey, result: "win" })).status).toBe(200);
  expect(events.find(e => e.payload.manual)?.payload).toMatchObject({ type: "prediction-settled", manual: true, pointsEach: 0 });
  await round("next-game"); await engagement.settlePrediction([TOKEN], { gameKey: "game-one", result: "loss" });
  expect((await db.multichatPredictions.findOne({ token: TOKEN, gameKey: "next-game" })).settled).toBe(false);
  expect(await db.multichatViewers.countDocuments({ token: TOKEN, "oracle.total": { $gt: 0 } })).toBe(0);
  expect((await engagement.summary(TOKEN)).oracleRecap.calls).toBe(0);
});
test("cancel is exact, terminal, broadcasts once and does not change scores", async () => {
  await round(); expect((await post({ action: "predictionCancel", gameKey: "other" })).status).toBe(409);
  const responses = await Promise.all([post({ action: "predictionCancel", gameKey: live.gameKey }), post({ action: "predictionCancel", gameKey: live.gameKey })]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  expect(events.filter(e => e.payload.type === "prediction-cancelled")).toHaveLength(1);
  expect(await db.multichatViewers.countDocuments({})).toBe(0);
});
test("concurrent verified results award a viewer only once", async () => {
  await round(); await Promise.all(Array.from({ length: 8 }, () => engagement.settlePrediction([TOKEN], { gameKey: "game-one", result: "win" })));
  expect((await db.multichatViewers.findOne({ token: TOKEN })).oracle).toMatchObject({ total: 1, correct: 1, score: 10 });
});
test("session reset preserves foreign owner, bounds subsequent games and stamps stream mark", async () => {
  const now = Date.now(); await db.users.insertOne({ userId: "foreign", clerkUserId: "foreign-clerk", sessionAnchorAt: "2020-01-01T00:00:00.000Z" });
  await db.games.insertOne({ userId: OWNER, gameId: "before", date: new Date(now - 60_000), result: "win", myMmr: 5000 });
  expect((await games.todaySession(OWNER)).wins).toBe(1);
  const response = await post({ action: "sessionReset" }); expect(response.status).toBe(200);
  expect(response.body.streamStartMs).toBeGreaterThanOrEqual(now);
  expect((await games.todaySession(OWNER, undefined, { reuseRecent: true }))).toMatchObject({ wins: 0, losses: 0, games: 0 });
  expect((await db.users.findOne({ userId: "foreign" })).sessionAnchorAt).toBe("2020-01-01T00:00:00.000Z");
  expect(events.filter(event => event.event === "games:changed")).toEqual([
    { room: `user:${OWNER}`, event: "games:changed", payload: { count: 0, inserted: 0, bulk: false, reason: "session-reset" } },
  ]);
  expect(events.filter(e => e.event === "overlay:session").map(e => e.room)).toEqual([`overlay:${TOKEN}`]);
  await db.games.insertOne({ userId: OWNER, gameId: "after", date: new Date(), result: "loss", myMmr: 4990 });
  games.invalidateForUser(OWNER); expect((await games.todaySession(OWNER))).toMatchObject({ wins: 0, losses: 1, games: 1 });
});
test("pause persists a strict boolean and can be reversed", async () => {
  expect((await post({ action: "gamePause", paused: true })).body.gameWidgetsPaused).toBe(true);
  expect((await post({ action: "gamePause", paused: false })).body.gameWidgetsPaused).toBe(false);
});
test("a persisted anchor ahead of the clock still excludes earlier games", async () => {
  const anchor = new Date(Date.now() + 60_000).toISOString();
  await db.users.updateOne({ userId: OWNER }, { $set: { sessionAnchorAt: anchor } });
  await db.games.insertOne({ userId: OWNER, gameId: "before-clock-boundary", date: new Date(Date.now() - 1000), result: "win" });
  expect(await games.todaySession(OWNER)).toMatchObject({ wins: 0, losses: 0, games: 0, sessionAnchorAt: anchor });
});
test("shoutout offers copy text without a bot and never accepts arbitrary target or message", async () => {
  live.phase = "match_in_progress";
  await db.playerChannels.insertOne({ identityKeys: ["toon:1-S2-1-123"], source: "admin", channels: { twitch: "https://twitch.tv/approved" } });
  const response = await post({ action: "shoutout", gameKey: live.gameKey });
  expect(response.status).toBe(200); expect(response.body.deskAction).toEqual({ queued: false, shoutoutText: "Check out our opponent's stream: https://www.twitch.tv/approved" });
  expect((await post({ action: "shoutout", gameKey: live.gameKey, text: "arbitrary" })).status).toBe(400);
  live.phase = "match_ended"; expect((await post({ action: "shoutout", gameKey: live.gameKey })).status).toBe(409);
});

test.each(["before", "after"])("award failure %s durable write resumes and drains before a newer verified round", async boundary => {
  await round();
  await db.multichatPredictions.updateOne({ token: TOKEN, gameKey: "game-one" }, { $set: { "picks.bob": { user: "Bob", platform: "twitch", pick: "win" } } });
  const write = db.multichatViewers.updateOne.bind(db.multichatViewers);
  let failed = false;
  const spy = jest.spyOn(db.multichatViewers, "updateOne").mockImplementation(async (...args) => {
    if (!failed && boundary === "before") { failed = true; throw new Error("ack lost before score"); }
    const value = await write(...args);
    if (!failed) { failed = true; throw new Error("ack lost after durable score"); }
    return value;
  });
  await expect(engagement.settlePrediction([TOKEN], { gameKey: "game-one", result: "win" })).rejects.toThrow("ack lost");
  expect(await engagement.cancel(TOKEN, "game-one")).toBe(false);
  expect(await engagement.manualSettle(TOKEN, "game-one", "loss")).toBe(false);
  expect((await db.multichatStudio.findOne({ studioKey: TOKEN })).oraclePending.gameKey).toBe("game-one");
  spy.mockRestore();
  await round("game-two");
  await db.multichatPredictions.updateOne({ token: TOKEN, gameKey: "game-two" }, { $set: { "picks.bob": { user: "Bob", platform: "twitch", pick: "win" } } });
  const restarted = new MultichatEngagementService(db);
  await restarted.settlePrediction([TOKEN], { gameKey: "game-two", result: "win" });
  for (const userKey of ["twitch:alice", "twitch:bob"]) expect((await db.multichatViewers.findOne({ token: TOKEN, userKey })).oracle).toMatchObject({ total: 2, correct: 2, score: 20, awardSequence: 2 });
  // A held older worker arriving after the next lane cannot duplicate points.
  await engagement.verifiedSettlement.award(TOKEN, 1, { user: "Bob", platform: "twitch", pick: "win" }, "win");
  expect((await db.multichatViewers.findOne({ token: TOKEN, userKey: "twitch:bob" })).oracle.total).toBe(2);
  expect((await db.multichatStudio.findOne({ studioKey: TOKEN })).oraclePending).toBeUndefined();
});

test.each(["tally", "leaders"])("summary resumes after %s failure without re-awarding", async boundary => {
  await round();
  const write = db.multichatPredictions.updateOne.bind(db.multichatPredictions);
  let failed = false;
  const tail = boundary === "leaders" ? jest.spyOn(engagement, "topOracles").mockRejectedValueOnce(new Error("settlement tail failed"))
    : jest.spyOn(db.multichatPredictions, "updateOne").mockImplementation((...args) => {
      if (!failed && args[1].$set?.settlementState === "complete") { failed = true; throw new Error("settlement tail failed"); }
      return write(...args);
    });
  await expect(engagement.settlePrediction([TOKEN], { gameKey: "game-one", result: "win" })).rejects.toThrow("settlement tail failed");
  tail.mockRestore();
  expect((await db.multichatPredictions.findOne({ token: TOKEN })).settlementState).toBe(boundary === "tally" ? "pending" : "complete");
  const restarted = new MultichatEngagementService(db);
  await restarted.summary(TOKEN);
  expect((await db.multichatViewers.findOne({ token: TOKEN })).oracle).toMatchObject({ total: 1, score: 10 });
  expect((await db.multichatPredictions.findOne({ token: TOKEN })).notifiedAt).toBeInstanceOf(Date);
  expect((await db.multichatStudio.findOne({ studioKey: TOKEN })).oraclePending).toBeUndefined();
});

test("whole Game Desk mutation joins rotation admission before any owner or token write", async () => {
  svc.deps.tokens.withWrite = jest.fn(async () => { throw Object.assign(new Error("rotating"), { status: 503, code: "overlay_rotation_pending" }); });
  expect((await post({ action: "sessionReset" })).status).toBe(503);
  expect((await db.users.findOne({ userId: OWNER })).sessionAnchorAt).toBeUndefined();
  expect(await db.multichatStudio.countDocuments({})).toBe(0);
});

test("a held full drain cannot publish an older reveal after the next round completed", async () => {
  await round(); let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const leaders = engagement.topOracles.bind(engagement);
  jest.spyOn(engagement, "topOracles").mockImplementationOnce(async (...args) => { entered(); await held; return leaders(...args); });
  const older = engagement.settlePrediction([TOKEN], { gameKey: "game-one", result: "win" }); await started;
  const resumed = new MultichatEngagementService(db, { io: engagement.io });
  await round("game-two");
  await resumed.settlePrediction([TOKEN], { gameKey: "game-two", result: "loss" });
  release(); await older;
  const reveals = events.filter(event => event.payload.type === "prediction-settled").map(event => event.payload);
  expect(reveals.map(event => event.gameKey)).toEqual(["game-one", "game-two"]);
  expect(reveals.map(event => event.settlementSequence)).toEqual([1, 2]);
  expect((await resumed.summary(TOKEN))).toMatchObject({ settlementSequence: 2, latestRoundKey: "game-two", prediction: null });
});

test("pending verified scores and scalar receipts resume through real token rotation", async () => {
  const tokens = new OverlayTokensService(db), original = await tokens.create(OWNER, "Synthetic");
  const scoring = new MultichatEngagementService(db, { overlayTokens: tokens });
  await scoring.openPrediction([original.token], { gameKey: "rotate-pending", opponent: "Synthetic" });
  await db.multichatPredictions.updateOne({ token: original.token, gameKey: "rotate-pending" }, { $set: { picks: {
    alice: { user: "Alice", platform: "twitch", pick: "win" }, bob: { user: "Bob", platform: "twitch", pick: "win" },
  } } });
  const write = db.multichatViewers.updateOne.bind(db.multichatViewers); let failed = false;
  const spy = jest.spyOn(db.multichatViewers, "updateOne").mockImplementation(async (...args) => { const result = await write(...args); if (!failed) { failed = true; throw new Error("lost score ack"); } return result; });
  await expect(scoring.settlePrediction([original.token], { gameKey: "rotate-pending", result: "win" })).rejects.toThrow("lost score ack"); spy.mockRestore();
  const replacement = await tokens.rotate(OWNER, original.token); expect(replacement.pending).toBe(false);
  expect((await db.multichatStudio.findOne({ studioKey: replacement.token })).oraclePending.gameKey).toBe("rotate-pending");
  await scoring.summary(replacement.token);
  for (const userKey of ["twitch:alice", "twitch:bob"]) expect((await db.multichatViewers.findOne({ token: replacement.token, userKey })).oracle).toMatchObject({ total: 1, score: 10, awardSequence: 1 });
  expect(await db.multichatViewers.countDocuments({ token: original.token })).toBe(0);
  await expect(scoring.summary(original.token)).rejects.toMatchObject({ code: "invalid_overlay_token" });
});

test.each(["owner-write", "stream-mark"])("reversed reset completion at %s retains the newer anchor and stream mark", async boundary => {
  const olderAt = Date.now() - 10_000, newerAt = olderAt + 5000;
  await db.games.insertOne({ userId: OWNER, gameId: "between-resets", date: new Date(olderAt + 2000), result: "win", myMmr: 5000 });
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  if (boundary === "owner-write") {
    const original = db.users.updateOne.bind(db.users); let first = true;
    jest.spyOn(db.users, "updateOne").mockImplementation(async (...args) => { if (first && args[1].$max) { first = false; entered(); await held; } return original(...args); });
  } else {
    const original = studio.advanceStreamStart.bind(studio); let first = true;
    jest.spyOn(studio, "advanceStreamStart").mockImplementation(async (...args) => { if (first) { first = false; entered(); await held; } return original(...args); });
  }
  svc.now = () => olderAt;
  const older = svc.resetSession(OWNER, TOKEN); await started;
  const newerSvc = new GameDeskService({ ...svc.deps, now: () => newerAt });
  await newerSvc.resetSession(OWNER, TOKEN);
  release(); await older;
  expect((await db.users.findOne({ userId: OWNER })).sessionAnchorAt).toBe(new Date(newerAt).toISOString());
  expect((await studio.get(TOKEN)).streamStartMs).toBe(newerAt);
  expect((await games.todaySession(OWNER))).toMatchObject({ wins: 0, games: 0 });
  jest.restoreAllMocks();
});

test("a committed policy change during held token-list IO retires reset fanout without undoing the reset", async () => {
  const revisions = new OwnerRevisions();
  games.sessionPolicy = new SessionPolicyService(db, { revisions });
  games.users.onSessionPolicyChanged = userId => {
    games.sessionPolicy.invalidate(userId); games.invalidateSessionPolicy(userId); revisions.invalidate(userId);
  };
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const original = svc.deps.tokens.list;
  const listing = jest.spyOn(svc.deps.tokens, "list").mockImplementationOnce(async userId => {
    entered(); await held; return original(userId);
  });
  try {
    const old = svc.resetSession(OWNER, TOKEN); await started;
    try { await games.users.updateProfile(OWNER, { sessionGapMinutes: 15 }); }
    finally { release(); }
    const state = await old;
    expect(state.streamStartMs).toBeGreaterThan(0);
    expect((await db.users.findOne({ userId: OWNER })).sessionAnchorAt).toBeDefined();
    expect(events.filter(event => event.event === "overlay:session")).toEqual([]);
    expect(events.filter(event => event.event === "games:changed")).toEqual([
      { room: `user:${OWNER}`, event: "games:changed", payload: { count: 0, inserted: 0, bulk: false, reason: "session-reset" } },
    ]);
    await svc.resetSession(OWNER, TOKEN);
    const current = events.filter(event => event.event === "overlay:session");
    expect(current.map(event => event.room)).toEqual([`overlay:${TOKEN}`]);
    expect(current[0].payload).toMatchObject({ wins: 0, losses: 0, games: 0, sessionGapMinutes: 15, sessionPolicySource: "preference" });
    expect(Object.values(current[0].payload).some(value => typeof value === "function")).toBe(false);
    expect(JSON.stringify(current[0].payload)).not.toMatch(/lease|generation|assertCurrent/);
  } finally { release(); listing.mockRestore(); }
});

test("a committed reset keeps its ACK when an actual held session query is retired by a Profile write", async () => {
  const revisions = new OwnerRevisions();
  games.sessionPolicy = new SessionPolicyService(db, { revisions });
  games.users.onSessionPolicyChanged = userId => {
    games.sessionPolicy.invalidate(userId); games.invalidateSessionPolicy(userId); revisions.invalidate(userId);
  };
  let entered, release, first = true;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const original = db.games.find.bind(db.games);
  const finding = jest.spyOn(db.games, "find").mockImplementation((...args) => {
    const cursor = original(...args);
    if (first) {
      first = false;
      const read = cursor.toArray.bind(cursor);
      cursor.toArray = async () => { entered(); await held; return read(); };
    }
    return cursor;
  });
  const listing = jest.spyOn(svc.deps.tokens, "list");
  try {
    const old = svc.resetSession(OWNER, TOKEN); await started;
    try { await games.users.updateProfile(OWNER, { sessionGapMinutes: 15 }); }
    finally { release(); }
    const state = await old;
    expect(state.streamStartMs).toBeGreaterThan(0);
    expect((await db.users.findOne({ userId: OWNER })).sessionAnchorAt).toBeDefined();
    expect(listing).not.toHaveBeenCalled();
    expect(events.filter(event => event.event === "overlay:session")).toEqual([]);
    expect(events.filter(event => event.event === "games:changed")).toEqual([
      { room: `user:${OWNER}`, event: "games:changed", payload: { count: 0, inserted: 0, bulk: false, reason: "session-reset" } },
    ]);
    await svc.resetSession(OWNER, TOKEN);
    const current = events.filter(event => event.event === "overlay:session");
    expect(current.map(event => event.room)).toEqual([`overlay:${TOKEN}`]);
    expect(current[0].payload).toMatchObject({ games: 0, sessionGapMinutes: 15, sessionPolicySource: "preference" });
    expect(listing).toHaveBeenCalledTimes(1);
  } finally { release(); finding.mockRestore(); listing.mockRestore(); }
});

test.each(["resolution", "token-list", "publication"])("a non-retirement %s failure still rejects the committed reset", async boundary => {
  const failure = new Error(`unrelated ${boundary} failure`);
  const originalTo = svc.deps.io.to.bind(svc.deps.io);
  let publicationEntered = false;
  const listing = boundary === "publication" ? jest.spyOn(svc.deps.tokens, "list") : null;
  const spy = boundary === "resolution"
    ? jest.spyOn(games, "todaySession").mockRejectedValueOnce(failure)
    : boundary === "token-list"
      ? jest.spyOn(svc.deps.tokens, "list").mockRejectedValueOnce(failure)
      : jest.spyOn(svc.deps.io, "to").mockImplementation(room => {
        const emitter = originalTo(room);
        return { emit: (event, payload) => {
          if (event === "overlay:session") { publicationEntered = true; throw failure; }
          return emitter.emit(event, payload);
        } };
      });
  try {
    await expect(svc.resetSession(OWNER, TOKEN)).rejects.toBe(failure);
    expect(events.filter(event => event.event === "games:changed")).toEqual([
      { room: `user:${OWNER}`, event: "games:changed", payload: { count: 0, inserted: 0, bulk: false, reason: "session-reset" } },
    ]);
    if (boundary === "publication") {
      expect(publicationEntered).toBe(true);
      expect(listing).toHaveBeenCalledTimes(1); expect(listing).toHaveBeenCalledWith(OWNER);
      expect(events.some(event => event.event === "overlay:multichat")).toBe(true);
    }
  } finally { spy.mockRestore(); listing?.mockRestore(); }
});

test("confirmed reset invalidates the owner before optional overlay session work finishes", async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const original = games.todaySession.bind(games);
  const query = jest.spyOn(games, "todaySession").mockImplementationOnce(async (...args) => {
    entered(); await held; return original(...args);
  });
  const pending = svc.resetSession(OWNER, TOKEN);
  try {
    await started;
    const owner = await db.users.findOne({ userId: OWNER });
    expect((await studio.get(TOKEN)).streamStartMs).toBe(Date.parse(owner.sessionAnchorAt));
    expect(events.filter(event => event.event === "games:changed")).toEqual([
      { room: `user:${OWNER}`, event: "games:changed", payload: { count: 0, inserted: 0, bulk: false, reason: "session-reset" } },
    ]);
    expect(events.filter(event => event.event === "overlay:session")).toEqual([]);
  } finally { release(); try { await pending; } finally { query.mockRestore(); } }
});

test.each(["before", "after"])("failed owner reset write %s durable commit emits no refresh", async boundary => {
  const failure = new Error(`reset write failure ${boundary}`), original = db.users.updateOne.bind(db.users);
  const write = jest.spyOn(db.users, "updateOne").mockImplementationOnce(async (...args) => {
    if (boundary === "after") await original(...args);
    throw failure;
  });
  const advance = jest.spyOn(studio, "advanceStreamStart");
  try {
    await expect(svc.resetSession(OWNER, TOKEN)).rejects.toBe(failure);
    expect(events.filter(event => event.event === "games:changed")).toEqual([]);
    expect(advance).not.toHaveBeenCalled();
    expect(Boolean((await db.users.findOne({ userId: OWNER })).sessionAnchorAt)).toBe(boundary === "after");
  } finally { write.mockRestore(); advance.mockRestore(); }
});

test("an unmatched owner reset cannot emit another owner's refresh or insert an owner", async () => {
  const advance = jest.spyOn(studio, "advanceStreamStart");
  try {
    await expect(svc.resetSession("missing-owner", TOKEN)).rejects.toMatchObject({ status: 404, code: "user_not_found" });
    expect(await db.users.countDocuments({ userId: "missing-owner" })).toBe(0);
    expect((await db.users.findOne({ userId: OWNER })).sessionAnchorAt).toBeUndefined();
    expect(events.filter(event => event.event === "games:changed")).toEqual([]);
    expect(advance).not.toHaveBeenCalled();
  } finally { advance.mockRestore(); }
});

test("an unavailable committed anchor read emits no unconfirmed refresh", async () => {
  const read = jest.spyOn(db.users, "findOne").mockResolvedValueOnce(null);
  const advance = jest.spyOn(studio, "advanceStreamStart");
  try {
    await expect(svc.resetSession(OWNER, TOKEN)).rejects.toThrow("session anchor unavailable");
    expect(events.filter(event => event.event === "games:changed")).toEqual([]);
    expect(advance).not.toHaveBeenCalled();
  } finally { read.mockRestore(); advance.mockRestore(); }
});

test("a failed stream mark preserves its failure without announcing a completed reset", async () => {
  const failure = new Error("stream mark failed");
  const advance = jest.spyOn(studio, "advanceStreamStart").mockRejectedValueOnce(failure);
  const query = jest.spyOn(games, "todaySession");
  try {
    await expect(svc.resetSession(OWNER, TOKEN)).rejects.toBe(failure);
    expect((await db.users.findOne({ userId: OWNER })).sessionAnchorAt).toBeDefined();
    expect(events.filter(event => event.event === "games:changed")).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  } finally { advance.mockRestore(); query.mockRestore(); }
});

test("an unrelated owner refresh emission failure is not swallowed as overlay retirement", async () => {
  const failure = new Error("owner signal failed"), original = svc.deps.io.to.bind(svc.deps.io);
  let reached = false;
  const emit = jest.spyOn(svc.deps.io, "to").mockImplementation(room => {
    const emitter = original(room);
    return { emit: (event, payload) => {
      if (event === "games:changed") { reached = true; expect(room).toBe(`user:${OWNER}`); throw failure; }
      return emitter.emit(event, payload);
    } };
  });
  const query = jest.spyOn(games, "todaySession");
  try {
    await expect(svc.resetSession(OWNER, TOKEN)).rejects.toBe(failure);
    expect(reached).toBe(true);
    expect(events.some(event => event.event === "overlay:multichat")).toBe(true);
    expect((await db.users.findOne({ userId: OWNER })).sessionAnchorAt).toBeDefined();
    expect(query).not.toHaveBeenCalled();
  } finally { emit.mockRestore(); query.mockRestore(); }
});