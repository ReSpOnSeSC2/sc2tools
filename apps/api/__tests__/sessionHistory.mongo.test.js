"use strict";

// Prove scalar-index bounds separately from malformed-date semantics:
// inserting one Date array makes the shared index permanently multikey.
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const { pino } = require("pino");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { loadConfig } = require("../src/config/loader");
const { SessionHistoryService } = require("../src/services/sessionHistory");
const { sha256 } = require("../src/util/hash");
const { createBackupStore } = require("./helpers/userBackupsStore");

/** @type {MongoMemoryServer} */
let mongo;
/** @type {import("../src/db/connect").DbContext} */
let db;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// All test history is in the past; no global/fake clock or provider is needed.
const START = Date.UTC(2025, 0, 2);
const rawToken = "session-history-owner-a-device-token-0123456789";
const authorization = `Bearer ${rawToken}`;

/** @param {boolean} [cacheEnabled] @param {import("../src/db/connect").DbContext} [database] */
function appFor(cacheEnabled = false, database = db) {
  // Complete synthetic configuration; never read process.env or real secrets.
  const config = loadConfig({
    MONGODB_URI: "mongodb://127.0.0.1:27017/session_history_fixture",
    CLERK_SECRET_KEY: "synthetic-unused-clerk-key",
    SERVER_PEPPER_HEX: "08".repeat(32), NODE_ENV: "test",
    USER_CACHE_ENABLED: String(cacheEnabled), RATE_LIMIT_PER_MINUTE: "5000",
    SC2_PY_ANALYZER_DIR: "/none",
  });
  const built = buildApp({
    db: database, userBackupsStore: createBackupStore(), logger: pino({ level: "silent" }),
    clerkClient: { getEmail: async () => null, deleteUser: async () => {} },
    config: { ...config, clerkSecretKey: "" },
  });
  if (!("sessionHistory" in built.services) || !(built.services.sessionHistory instanceof SessionHistoryService)) {
    throw new Error("Expected actual SessionHistoryService from buildApp");
  }
  return { app: built.app, history: built.services.sessionHistory };
}

/** @param {import("express").Express} app @param {string} path */
const get = (app, path) => request(app).get(path).set("authorization", authorization);

/** @param {string} gameId @param {number} offsetMinutes
 * @param {import("mongodb").Document} [patch] */
function game(gameId, offsetMinutes, patch = {}) {
  return { userId: "a", gameId, date: new Date(START + offsetMinutes * MINUTE),
    result: "Victory", myRace: "Protoss", myToonHandle: "1-S2-1-123",
    opponent: { race: "Zerg", toonHandle: "1-S2-1-456" },
    isLadderGame: true, playerCount: 2, map: "Synthetic map", durationSec: 120,
    ...patch };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  // connect installs only the repository's existing test database indexes.
  // No production indexes, collections, migrations or data are changed.
  db = await connect({ uri: mongo.getUri(), dbName: "session_history_contract" });
});

beforeEach(async () => {
  jest.restoreAllMocks();
  for (const collection of [db.users, db.deviceTokens, db.overlayTokens, db.games, db.gameDetails, db.pendingIdentityDeletions]) {
    await collection.deleteMany({});
  }
  await db.users.insertOne({ userId: "a", clerkUserId: "clerk_history_a", dataRev: 0 });
  await db.deviceTokens.insertOne({ userId: "a", tokenHash: sha256(rawToken),
    createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null });
});

afterEach(() => jest.restoreAllMocks());
afterAll(async () => { if (db) await db.close(); if (mongo) await mongo.stop(); });
/** @param {Record<string, string|number>} [extra] */
function listPath(extra = {}) {
  const query = new URLSearchParams({ windowFrom: new Date(START).toISOString(),
    windowTo: new Date(START + DAY).toISOString(), ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, String(value)])) });
  return `/v1/sessions?${query}`;
}

/** @param {unknown} value @returns {Array<Record<string, unknown>>} */
function indexScans(value) {
  if (!value || typeof value !== "object") return [];
  const object = /** @type {Record<string, unknown>} */ (value);
  const scans = object.stage === "IXSCAN" || object.stage === "EXPRESS_IXSCAN" ? [object] : [];
  return scans.concat(Object.values(object).flatMap(indexScans));
}


/** Watch the ACTUAL Mongo cursor; every method delegates to that instance.
 * No service, query, cursor data or normalization is replaced by this observer.
 * @param {import("../src/db/connect").DbContext} [database] */
function watchCandidateReads(database = db) {
  const original = database.games.aggregate.bind(database.games);
  /** @type {Array<{cursor:import("mongodb").AggregationCursor<import("mongodb").Document>,next:jest.SpyInstance,close:jest.SpyInstance}>} */
  const reads = [];
  const aggregate = jest.spyOn(database.games, "aggregate").mockImplementation((pipeline, options) => {
    const cursor = original(pipeline, options);
    reads.push({ cursor, next: jest.spyOn(cursor, "next"), close: jest.spyOn(cursor, "close") });
    return cursor;
  });
  return { aggregate, reads };
}
/** @param {unknown} value @returns {Record<string,unknown>} */
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string,unknown>} */ (value) : {}; }
/** Choose ONLY the actual winning plan, never rejected plans as proof.
 * @param {import("mongodb").Document} explain */
function explainParts(explain) {
  const cursor = Array.isArray(explain.stages) ? explain.stages.find(stage => stage.$cursor)?.$cursor : null;
  const planner = explain.queryPlanner ?? cursor?.queryPlanner;
  const stats = explain.executionStats ?? cursor?.executionStats;
  if (!planner?.winningPlan || !stats) throw new Error("Expected actual winning plan and execution statistics");
  return { plan: planner.winningPlan, stats };
}
/** Separate LOCAL diagnostic, never another query made by the service.
 * @param {import("../src/db/connect").DbContext} database
 * @param {import("mongodb").Document[]} pipeline @param {import("mongodb").AggregateOptions|undefined} options */
async function candidateExplain(database, pipeline, options) {
  const cursor = database.games.aggregate(pipeline, options);
  try { return await cursor.explain("executionStats"); } finally { await cursor.close(); }
}
/** @param {import("../src/db/connect").DbContext} database */
async function seedOwner(database) {
  await database.users.insertOne({ userId: "a", clerkUserId: "clerk_history_a", dataRev: 0 });
  await database.deviceTokens.insertOne({ userId: "a", tokenHash: sha256(rawToken), createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null });
}
/** @param {import("mongodb").Document} explain @param {import("mongodb").Document[]} pipeline */
function assertScalarDateBounds(explain, pipeline) {
  const { plan, stats } = explainParts(explain);
  const scan = indexScans(plan).find(node => { const key = object(node.keyPattern); return key.userId !== undefined && key.date !== undefined; });
  if (!scan) throw new Error("Expected actual winning owner/date index scan");
  expect(scan.isMultiKey).toBe(false);
  const dateBounds = JSON.stringify(object(scan.indexBounds).date), requested = pipeline[0].$match.date;
  expect(dateBounds).toContain(String(requested.$gte.getTime()));
  expect(dateBounds).toContain(String(requested.$lte.getTime()));
  expect(typeof stats.totalKeysExamined).toBe("number");
  expect(typeof stats.totalDocsExamined).toBe("number");
  expect(stats.totalDocsExamined).toBeLessThan(1000); // unchanged threshold, now on a proven scalar index
}

test("fresh scalar namespace proves both indexed date bounds without weakening the documents threshold", async () => {
  // Multikey metadata is sticky; deleting arrays from the adversarial collection
  // does not make its indexes scalar. Use a fresh namespace with the unchanged
  // connect-installed indexes, never drop/rebuild/hint an existing index.
  const scalarDb = await connect({ uri: mongo.getUri(), dbName: "session_history_scalar_bounds" });
  try {
    await seedOwner(scalarDb);
    await scalarDb.games.insertMany([game("scalar-first", 0), game("scalar-next", 60),
      ...Array.from({ length: 1000 }, (_, index) => game(`old-scalar-${index}`, -100 * 24 * 60 + index)),
      ...Array.from({ length: 200 }, (_, index) => game(`other-owner-${index}`, index, { userId: "b" }))]);
    const { app } = appFor(false, scalarDb), { aggregate, reads } = watchCandidateReads(scalarDb);
    const response = await get(app, listPath());
    expect(response.status).toBe(200); expect(response.body.status).toBe("ready");
    expect(response.body.items[0]).toMatchObject({ games: 2, wins: 2 });
    expect(aggregate).toHaveBeenCalledTimes(1);
    const call = aggregate.mock.calls[0];
    if (!call || !call[0]) throw new Error("Expected the real scalar candidate pipeline");
    expect(reads).toHaveLength(1); expect(reads[0].cursor.closed).toBe(true);
    const explain = await candidateExplain(scalarDb, call[0], call[1]);
    assertScalarDateBounds(explain, call[0]);
  } finally { await scalarDb.close(); }
});
test("one private window query preserves scalar-Date and privacy semantics on a multikey corpus", async () => {
  const { app } = appFor();
  const scalar = [game("win", 0), game("unknown-bridge", 60, { result: "Tie" }), game("loss", 120, { result: "Defeat" })];
  await db.games.insertMany([
    ...scalar.map(row => ({ ...row, macroBreakdown: { secret: "heavy-private-fixture" }, buildLog: "heavy-private-fixture" })),
    game("array-date", 30, { date: [new Date(START + 30 * MINUTE)] }),
    game("legacy-string", 30, { date: new Date(START + 30 * MINUTE).toISOString() }),
    game("legacy-number", 30, { date: START + 30 * MINUTE }),
    game("null-date", 30, { date: null }), game("foreign", 30, { userId: "b" }),
    game("excluded", 30, { excluded: true }), game("deleted", 30, { _deleted: true }),
    game("pending-delete", 30, { _deletionPending: true }), game("resumed", 30, { isResumedFromReplay: true }),
    ...Array.from({ length: 1000 }, (_, index) => game(`outside-${index}`, -100 * 24 * 60 + index)),
    ...Array.from({ length: 200 }, (_, index) => game(`foreign-${index}`, index, { userId: "b" })),
  ]);
  const { aggregate, reads } = watchCandidateReads();
  const detailFind = jest.spyOn(db.gameDetails, "findOne"), detailAggregate = jest.spyOn(db.gameDetails, "aggregate");
  const response = await get(app, listPath());
  expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.body.status).toBe("ready"); expect(response.body.items).toHaveLength(1);
  expect(response.body.items[0]).toMatchObject({ games: 3, wins: 1, losses: 1, unknown: 1, results: "WUL" });
  expect(response.text).not.toContain("heavy-private-fixture");
  expect(aggregate).toHaveBeenCalledTimes(1);
  const call = aggregate.mock.calls[0];
  if (!call || !call[0]) throw new Error("Expected the one real candidate pipeline");
  const [pipeline, options] = call;
  expect(pipeline[0].$match.userId).toBe("a");
  expect(pipeline[0].$match.date.$gte).toBeInstanceOf(Date);
  expect(pipeline[0].$match.date.$lte ?? pipeline[0].$match.date.$lt).toBeInstanceOf(Date);
  const scalarStage = pipeline.findIndex(stage => stage.$match?.$expr);
  expect(scalarStage).toBeGreaterThanOrEqual(0);
  expect(pipeline[scalarStage].$match.$expr).toEqual({ $eq: [{ $type: "$date" }, "date"] });
  const projection = pipeline.find(stage => stage.$project)?.$project;
  if (!projection) throw new Error("Expected the bounded slim projection");
  for (const key of ["macroBreakdown", "buildLog", "oppBuildLog", "stats_events", "unit_timeline", "playbackEvents"]) expect(projection[key]).toBeUndefined();
  expect(pipeline.some(stage => stage.$limit === 5001)).toBe(true);
  expect(options?.maxTimeMS).toBe(2000); expect(options?.batchSize).toBe(32);
  expect(reads).toHaveLength(1); expect(reads[0].next).toHaveBeenCalledTimes(4);
  expect(reads[0].close).toHaveBeenCalled(); expect(reads[0].cursor.closed).toBe(true);
  expect(detailFind).not.toHaveBeenCalled(); expect(detailAggregate).not.toHaveBeenCalled();
  // This is a separate LOCAL diagnostic query, not an extra service query.
  // Record actual planner evidence; never manufacture documents-examined counts.
  const explain = await candidateExplain(db, pipeline, options);
  const { plan, stats } = explainParts(explain);
  const scans = indexScans(plan);
  expect(scans.some(scan => {
    const pattern = /** @type {Record<string, unknown>} */ (scan.keyPattern);
    return pattern && pattern.userId !== undefined && pattern.date !== undefined;
  })).toBe(true);
  expect(typeof stats.totalKeysExamined).toBe("number");
  expect(typeof stats.totalDocsExamined).toBe("number");
  // Date arrays intentionally make this index multikey. This adversarial case
  // proves semantic exclusion and time/returned-row admission, not both index
  // bounds or a physical documents-examined cap. First actual explain is retained.
  expect(scans.some(scan => scan.isMultiKey === true)).toBe(true);
});

test.each([-1, 0, 1])("complete sessions split only above exact gap by%dms and keep unknown bridges", async delta => {
  const { app } = appFor();
  await db.games.insertMany([game("first", 120), game("bridge", 210, { result: "Tie" }),
    game("last", 300, { date: new Date(START + 300 * MINUTE + delta), result: "Defeat" })]);
  const response = await get(app, listPath());
  expect(response.status).toBe(200); expect(response.body.status).toBe("ready");
  expect(response.body.definition.gapMinutes).toBe(90);
  expect(response.body.items).toHaveLength(delta > 0 ? 2 : 1);
  /** @type {import("../src/services/sessionHistoryTypes").HistorySummary[]} */
  const items = response.body.items;
  expect(items.reduce((sum, item) => sum + item.games, 0)).toBe(3);
  expect(items.reduce((sum, item) => sum + item.wins, 0)).toBe(1);
  expect(items.reduce((sum, item) => sum + item.losses, 0)).toBe(1);
  expect(items.reduce((sum, item) => sum + item.unknown, 0)).toBe(1);
  if (delta <= 0) expect(items[0].results).toBe("WUL");
});

test("continuous chains at an unproved scan edge require explicit context rather than a partial session", async () => {
  const { app } = appFor();
  await db.games.insertMany(Array.from({ length: 7 }, (_, index) => game(`chain-${index}`, index * 60)));
  const window = { windowFrom: new Date(START + 120 * MINUTE).toISOString(), windowTo: new Date(START + 180 * MINUTE).toISOString() };
  const clipped = await get(app, listPath(window));
  expect(clipped.status).toBe(200); expect(clipped.body.status).toBe("context_required");
  expect(clipped.body.items).toEqual([]); expect(clipped.body.nextBefore).toBeNull();
  expect(clipped.body.issue).toEqual(expect.objectContaining({ code: expect.any(String) }));
  const expanded = await get(app, listPath({ ...window, contextDays: 1 }));
  expect(expanded.status).toBe(200); expect(expanded.body.status).toBe("ready");
  expect(expanded.body.items).toHaveLength(1);
  expect(expanded.body.items[0]).toMatchObject({ games: 7, wins: 7, losses: 0, unknown: 0 });
});

test("5001 candidate rows return an honest narrow-window state without summaries or cursor", async () => {
  const { app } = appFor();
  // Numeric legacy IDs remain eligible and unique in the existing Mongo index.
  // Omit optional fields so the normalized 2MiB budget does not mask row 5001.
  await db.games.insertMany(Array.from({ length: 5001 }, (_, index) => ({
    userId: "a", gameId: index, date: new Date(START + 120 * MINUTE + index * 1000),
  })));
  const { aggregate, reads } = watchCandidateReads();
  const response = await get(app, listPath());
  expect(response.status).toBe(200); expect(response.body.status).toBe("narrow_window");
  expect(response.body.items).toEqual([]); expect(response.body.nextBefore).toBeNull();
  expect(aggregate).toHaveBeenCalledTimes(1); expect(reads).toHaveLength(1);
  expect(reads[0].next).toHaveBeenCalledTimes(5001);
  expect(reads[0].close).toHaveBeenCalled(); expect(reads[0].cursor.closed).toBe(true);
  expect(response.body.issue).toEqual(expect.objectContaining({ code: expect.any(String) }));
});

test("a full cross-window component has one natural ID independent of output day", async () => {
  const { app } = appFor();
  await db.games.insertMany([game("prior-day", -30), game("at-midnight", 0, { result: "Tie" }), game("next-day", 30, { result: "Defeat" })]);
  const first = await get(app, listPath({ windowFrom: new Date(START - 60 * MINUTE).toISOString(), windowTo: new Date(START).toISOString(), contextDays: 1 }));
  const second = await get(app, listPath({ windowFrom: new Date(START).toISOString(), windowTo: new Date(START + 60 * MINUTE).toISOString(), contextDays: 1 }));
  expect(first.status).toBe(200); expect(second.status).toBe(200);
  expect(first.body.status).toBe("ready"); expect(second.body.status).toBe("ready");
  expect(first.body.items).toHaveLength(1); expect(second.body.items).toHaveLength(1);
  expect(first.body.items[0].id).toBe(second.body.items[0].id);
  expect(second.body.items[0]).toMatchObject({ games: 3, wins: 1, losses: 1, unknown: 1, results: "WUL",
    start: new Date(START - 30 * MINUTE).toISOString(), end: new Date(START + 30 * MINUTE).toISOString() });
  const detail = await get(app, `/v1/sessions/${encodeURIComponent(first.body.items[0].id)}?gamesLimit=100&contextDays=1`);
  expect(detail.status).toBe(200); expect(detail.body.status).toBe("ready");
  /** @type {import("../src/services/sessionHistoryTypes").HistoryGame[]} */
  const members = detail.body.games;
  expect(members.map(row => row.gameId)).toEqual(["prior-day", "at-midnight", "next-day"]);
  expect(detail.body.gamePage).toEqual({ limit: 100, count: 3, total: 3 });
});

test("whole-window cursor detects a late import in already visited time even when its last boundary session is unchanged", async () => {
  const { app } = appFor();
  await db.games.insertMany([game("oldest", 120), game("middle", 480), game("newest", 840)]);
  const initial = await get(app, listPath({ limit: 2 }));
  expect(initial.status).toBe(200); expect(initial.body.status).toBe("ready");
  expect(initial.body.items).toHaveLength(2); expect(typeof initial.body.nextBefore).toBe("string");
  await db.games.insertOne(game("late-in-visited-gap", 660));
  const next = await get(app, listPath({ limit: 2, before: initial.body.nextBefore }));
  expect(next.status).toBe(409); expect(next.body.error.code).toBe("session_view_changed");
  expect(next.body.items).toBeUndefined();
  const restarted = await get(app, listPath({ limit: 10 }));
  expect(restarted.status).toBe(200); expect(restarted.body.status).toBe("ready");
  expect(restarted.body.items).toHaveLength(4);
});
test("same-instant opaque IDs survive whole-component detail pagination without an offset or date tie being skipped", async () => {
  const { app } = appFor();
  const expected = ["A", "a", "\ue000", "\u{1f600}"];
  await db.games.insertMany([...expected].reverse().map(id => game(id, 120)));
  const listed = await get(app, listPath());
  expect(listed.status).toBe(200); expect(listed.body.status).toBe("ready");
  expect(listed.body.items).toHaveLength(1); expect(listed.body.items[0].games).toBe(4);
  const id = listed.body.items[0].id;
  /** @type {string|null} */ let before = null;
  /** @type {Array<string|null>} */ const seen = [];
  for (let index = 0; index < expected.length; index++) {
    const query = new URLSearchParams({ gamesLimit: "1" });
    if (before !== null) query.set("gamesBefore", before);
    const page = await get(app, `/v1/sessions/${encodeURIComponent(id)}?${query}`);
    expect(page.status).toBe(200); expect(page.body.status).toBe("ready");
    expect(page.body.gamePage).toEqual({ limit: 1, count: 1, total: 4 });
    expect(page.body.games).toHaveLength(1);
    expect(page.body.games[0]).toMatchObject({ gameId: expected[index], id: expected[index], position: index + 1 });
    seen.push(page.body.games[0].gameId); before = page.body.nextGamesBefore;
    if (index < expected.length - 1) expect(typeof before).toBe("string");
  }
  expect(before).toBeNull(); expect(seen).toEqual(expected);
});
test("a real Mongo read failure remains the original error when actual cursor cleanup also rejects after closing", async () => {
  const { history } = appFor();
  await db.games.insertOne(game("read-before-fault", 120));
  const readError = Object.assign(new Error("synthetic lost read acknowledgement"), { code: "history_test_read" });
  const cleanupError = new Error("synthetic cleanup acknowledgement");
  const original = db.games.aggregate.bind(db.games);
  /** @type {Array<import("mongodb").AggregationCursor<import("mongodb").Document>>} */
  const cursors = [];
  let cleanupCalls = 0;
  const aggregate = jest.spyOn(db.games, "aggregate").mockImplementationOnce((pipeline, options) => {
    const cursor = original(pipeline, options), next = cursor.next.bind(cursor), close = cursor.close.bind(cursor);
    cursors.push(cursor);
    jest.spyOn(cursor, "next").mockImplementationOnce(async () => {
      expect(await next()).not.toBeNull(); // the actual Mongo query executes
      throw readError;
    });
    jest.spyOn(cursor, "close").mockImplementation(async () => {
      cleanupCalls++;
      await close(); // close the actual owned cursor before simulating lost ACK
      throw cleanupError;
    });
    return cursor;
  });
  await expect(history.list("a", { windowFrom: new Date(START).toISOString(), windowTo: new Date(START + DAY).toISOString() })).rejects.toBe(readError);
  expect(aggregate).toHaveBeenCalledTimes(1); expect(cursors).toHaveLength(1);
  expect(cleanupCalls).toBeGreaterThan(0); expect(cursors[0].closed).toBe(true);
});
