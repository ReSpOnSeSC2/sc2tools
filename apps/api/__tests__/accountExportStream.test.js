// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { GdprService, USER_SCOPED_COLLECTIONS } = require("../src/services/gdpr");
const { GameDetailsService } = require("../src/services/gameDetails");
const { MongoDetailsStore, R2DetailsStore } = require("../src/services/gameDetailsStore");
const { accountExportStream } = require("../src/services/accountExportStream");

async function records(stream) {
  const out = [];
  for await (const chunk of stream) out.push(JSON.parse(chunk.toString("utf8")));
  return out;
}
function collected(rows) {
  const data = {}; let user;
  for (const row of rows) {
    if (row.type === "collection") data[row.name] = [];
    if (row.type === "record") data[row.collection].push(row.row);
    if (row.type === "user") user = row.row;
  }
  return { user, data };
}
function finiteCollection(rows) {
  const cursors = [];
  return {
    cursors,
    find: jest.fn((_filter, options) => {
      const cursor = { close: jest.fn(async () => {}), toArray: () => { throw Error("unbounded_toArray"); },
        async *[Symbol.asyncIterator]() { for (const row of rows) { options.signal?.throwIfAborted(); yield row; } } };
      cursors.push(cursor); return cursor;
    }),
  };
}

describe("full account export projections against disposable Mongo", () => {
  let mongo, client, db;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); db = client.db("account-export"); });
  afterAll(async () => { await client?.close(); await mongo?.stop(); });
  test("actual NDJSON matches legacy JSON and preserves every shared privacy projection", async () => {
    const names = [...USER_SCOPED_COLLECTIONS.map(([name]) => name), "users", "playerIdentitySubmissions", "multichatSounds", "playerGoals", "coaching", "playerChannels",
      "reviewRequests", "reviewComments", "reviewKarmaEvents", "reviewBlocks", "notifications", "adminAudit"];
    const ctx = Object.fromEntries(names.map(name => [name, db.collection(name)]));
    for (const [name] of USER_SCOPED_COLLECTIONS) {
      const own = { userId: "A", value: name };
      if (name === "customBuilds") own.loops = [{ name: "my loop", events: [1, 2] }];
      if (name === "overlayTokens") own.token = "owned-live-overlay-token";
      if (name === "deviceTokens") own.tokenHash = "owned-device-hash";
      await ctx[name].insertMany([own, { userId: "B", secret: "foreign-private" }]);
    }
    await ctx.users.insertOne({ userId: "A", name: "Owner", gameStats: { secret: "derived-private" }, gameStatsRevision: 9 });
    await ctx.playerIdentitySubmissions.insertOne({ userId: "A", label: "mine", reviewedBy: "reviewer-private", evidenceMaxId: "evidence-private" });
    await ctx.multichatSounds.insertOne({ userId: "A", label: "sound", data: Buffer.from("sound-private") });
    await ctx.playerChannels.insertOne({ ownerUserId: "A", label: "channel", updatedBy: "editor-private" });
    await ctx.playerGoals.insertMany([
      { userId: "A", id: "my-goal", params: { target: 3 }, slot: 1, criteriaRevision: 2 },
      { userId: "B", id: "foreign-private" },
    ]);
    await seedShared(ctx);
    const service = new GdprService(ctx, { reviews: {} });
    const legacy = await service.export("A");
    const rows = await records(service.exportStream("A"));
    expect(collected(rows)).toEqual(JSON.parse(JSON.stringify({ user: legacy.user, data: legacy.data })));
    expect(rows[0]).toMatchObject({ type: "metadata", format: "sc2tools-account-export", version: 1, userId: "A", details: false });
    expect(rows.at(-1)).toEqual({ type: "complete", counts: Object.fromEntries(Object.entries(legacy.data).map(([key, values]) => [key, values.length])) });
    const bytes = JSON.stringify(rows);
    expect(bytes).not.toMatch(/foreign-private|derived-private|reviewer-private|evidence-private|sound-private|editor-private|grant-private|student-private|moderator-private|actor-private|blocked-private|active-private/);
    expect(legacy.data.coachingRelationships).toEqual([
      { role: "coach", coach: { id: "coach-A", userId: "A", name: "Coach", own: "retained" } },
      { role: "student", student: { id: "student-A", userId: "A", name: "Me", coachId: "coach-B" }, coach: { id: "coach-B", name: "Other coach" } },
      { role: "coach_of_student", student: { id: "student-B", name: "Student", coachId: "coach-A", practiceSharing: null } },
    ]);
    expect(legacy.data.coachingAssignments[0]).toMatchObject({ coachUserId: "A" });
    expect(legacy.data.coachingAssignments[0]).not.toHaveProperty("studentUserId");
    expect(legacy.data.coachingAssignments[1]).toMatchObject({ studentUserId: "A" });
    expect(legacy.data.coachingAssignments[1]).not.toHaveProperty("coachUserId");
    expect(legacy.data.coachingCalendars).toEqual([
      { role: "student", calendar: { coachId: null, coachName: "Other", bookings: [{ studentUserId: "A", title: "my booking" }] } },
      { role: "coach", calendar: { coachUserId: "A", bookings: [{ title: "coach sees booking" }] } },
    ]);
    expect(legacy.data.adminAudit[0]).toMatchObject({ actorUserId: null, target: "A" });
    expect(legacy.data.reviewRequests[0]).toHaveProperty("_id");
    expect(legacy.data.notifications[0]).toHaveProperty("_id");
    expect(legacy.data.customBuilds[0].loops).toEqual([{ name: "my loop", events: [1, 2] }]);
    expect(legacy.data.playerGoals).toEqual([{ userId: "A", id: "my-goal", params: { target: 3 } }]);
    expect(bytes).toContain("owned-live-overlay-token");
    expect(bytes).toContain("owned-device-hash");
    expect((await service.export("A", { includeSharedCoaching: false })).data).not.toHaveProperty("coachingAssignments");
  });
});

async function seedShared(db) {
  await db.coaching.insertMany([
    { _id: "locker", state: { coaches: [
      { id: "coach-A", userId: "A", name: "Coach", own: "retained" }, { id: "coach-B", userId: "B", name: "Other coach", secret: "foreign-private" },
    ], students: [{ id: "student-B", userId: "B", name: "Student", coachId: "coach-A", secret: "student-private" }, { id: "student-A", userId: "A", name: "Me", coachId: "coach-B" }] } },
    { kind: "game_requirement", coachUserId: "A", studentUserId: "B", createdByUserId: "B", practiceSharingGrantId: "grant-private" },
    { kind: "game_requirement", coachUserId: "B", studentUserId: "A", createdByUserId: "B", practiceSharingGrantId: "grant-private" },
    { _id: "calendar:other", coachUserId: "B", coachName: "Other", bookings: [{ studentUserId: "A", title: "my booking" }, { studentUserId: "B", title: "foreign-private" }] },
    { _id: "calendar:own", coachUserId: "A", bookings: [{ studentUserId: "B", title: "coach sees booking" }] },
  ]);
  await db.reviewRequests.insertOne({ userId: "A", activeKey: "active-private", text: "request" });
  await db.reviewComments.insertOne({ authorId: "A", removedBy: "moderator-private", text: "comment" });
  await db.reviewKarmaEvents.insertOne({ userId: "A", actorId: "actor-private", points: 1 });
  await db.reviewBlocks.insertOne({ blockerId: "A", blockedId: "blocked-private", createdAt: new Date(0) });
  await db.notifications.insertOne({ userId: "A", text: "notification" });
  await db.adminAudit.insertOne({ actorUserId: "actor-private", target: "A", action: "fixed" });
  for (const [name, field] of [["reviewRequests", "userId"], ["reviewComments", "authorId"], ["reviewKarmaEvents", "userId"], ["reviewBlocks", "blockerId"], ["notifications", "userId"]]) {
    await db[name].insertOne({ [field]: "B", secret: "foreign-private" });
  }
}

test("present empty collection is declared; missing collection stays absent; cursors are bounded and closed", async () => {
  const users = finiteCollection([]), games = finiteCollection([]);
  const rows = await records(accountExportStream({ users, games }, null, "A"));
  expect(collected(rows)).toEqual({ user: null, data: { games: [] } });
  expect(games.find.mock.calls[0][1].batchSize).toBe(1);
  expect(games.cursors[0].close).toHaveBeenCalledTimes(1);
  expect(users.cursors[0].close).toHaveBeenCalledTimes(1);
});

test("consumer return closes held cursor and does not read ahead or emit complete", async () => {
  const games = finiteCollection([{ gameId: "one" }, { gameId: "two" }]);
  const stream = accountExportStream({ games, users: finiteCollection([]) }, null, "A");
  expect(JSON.parse((await stream.next()).value)).toHaveProperty("type", "metadata");
  expect(JSON.parse((await stream.next()).value)).toHaveProperty("type", "collection");
  expect(JSON.parse((await stream.next()).value).row.gameId).toBe("one");
  await stream.return();
  expect(games.cursors[0].close).toHaveBeenCalledTimes(1);
  expect((await stream.next()).done).toBe(true);
});

test("escaped over-budget row is never partially yielded and closes cursor without success", async () => {
  const games = finiteCollection([{ gameId: "huge", text: "\u0000".repeat(3 * 1024 * 1024) }]);
  const emitted = [];
  await expect((async () => { for await (const chunk of accountExportStream({ games, users: finiteCollection([]) }, null, "A")) emitted.push(chunk); })()).rejects.toThrow("export_record_too_large");
  expect(emitted.map(chunk => JSON.parse(chunk))).toEqual([
    expect.objectContaining({ type: "metadata" }), { type: "collection", name: "games" },
  ]);
  expect(games.cursors[0].close).toHaveBeenCalledTimes(1);
});

test("details retain one result; strict options and explicit missing status precede complete", async () => {
  const details = { findMany: jest.fn(async (_owner, [id]) => new Map(id === "one" ? [[id, { buildLog: [{ name: "Probe" }] }]] : [])) };
  const rows = await records(accountExportStream({ games: finiteCollection([{ gameId: "one" }, { gameId: "gone" }]), users: finiteCollection([]) }, details, "A", { details: true }));
  expect(details.findMany.mock.calls.map(([owner, ids, options]) => [owner, ids, options.strict, options.concurrency])).toEqual([
    ["A", ["one"], true, 1], ["A", ["gone"], true, 1],
  ]);
  expect(details.findMany.mock.calls[0][2].fields).toEqual(["buildLog", "oppBuildLog", "macroBreakdown", "apmCurve", "mapPlayback"]);
  expect(rows.filter(row => row.collection === "gameDetails").map(row => row.row)).toEqual([
    { gameId: "one", status: "available", details: { buildLog: [{ name: "Probe" }] } }, { gameId: "gone", status: "missing" },
  ]);
  expect(rows.at(-1)).toMatchObject({ type: "complete", counts: { games: 2, gameDetails: 2 } });
});

test("held detail failure settles before rejection and closes parent cursor, with no complete", async () => {
  let rejectRead; const entered = new Promise(resolve => { rejectRead = resolve; });
  let fail; const held = new Promise((_resolve, reject) => { fail = reject; });
  const details = { findMany: jest.fn(() => { rejectRead(); return held; }) };
  const games = finiteCollection([{ gameId: "one" }]), emitted = [];
  const work = (async () => { for await (const chunk of accountExportStream({ games }, details, "A", { details: true })) emitted.push(JSON.parse(chunk)); })();
  await entered; expect(games.cursors[0].close).not.toHaveBeenCalled();
  fail(Error("private-bucket/token"));
  await expect(work).rejects.toThrow("private-bucket/token");
  expect(games.cursors[0].close).toHaveBeenCalledTimes(1);
  expect(emitted.some(row => row.type === "complete")).toBe(false);
});

test("Mongo detail held next receives cancellation and its cursor is closed", async () => {
  const controller = new AbortController(); let entered, release, findOptions;
  const started = new Promise(resolve => { entered = resolve; });
  const cursor = { close: jest.fn(async () => {}), async *[Symbol.asyncIterator]() {
    entered();
    try {
      await new Promise((_resolve, reject) => {
        release = () => reject(Error("aborted"));
        controller.signal.addEventListener("abort", release, { once: true });
        if (controller.signal.aborted) release();
      });
    } finally { if (release) controller.signal.removeEventListener("abort", release); }
  } };
  const find = jest.fn((_filter, options) => { findOptions = options; return cursor; });
  const service = new GameDetailsService(new MongoDetailsStore({ gameDetails: { find } }));
  const work = service.findMany("A", ["one"], { signal: controller.signal, strict: true, concurrency: 1 });
  const settled = work.then(value => ({ kind: "settled", value }), error => ({ kind: "settled", error }));
  try {
    const admission = await Promise.race([started.then(() => ({ kind: "started" })), settled]);
    expect(admission.kind).toBe("started");
    expect(findOptions.signal).toBe(controller.signal);
    controller.abort();
    const outcome = await settled;
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error.message).toBe("aborted");
    expect(cursor.close).toHaveBeenCalledTimes(1);
  } finally {
    controller.abort(); release?.(); await settled;
  }
});

test("actual strict R2 detail failure cannot become a missing row followed by successful completion", async () => {
  const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
  const client = { send: jest.fn(async () => { throw Error("private-bucket-token"); }) };
  const store = new R2DetailsStore({ client, bucket: "synthetic-bucket", gameDetailsCollection: {} });
  const service = new GameDetailsService(store), games = finiteCollection([{ gameId: "one" }]), emitted = [];
  try {
    await expect((async () => {
      for await (const chunk of accountExportStream({ games, users: finiteCollection([]) }, service, "A", { details: true })) emitted.push(JSON.parse(chunk));
    })()).rejects.toThrow("private-bucket-token");
    expect(emitted.some(row => row.type === "complete")).toBe(false);
    expect(emitted.some(row => row.collection === "gameDetails")).toBe(false);
    expect(warning).not.toHaveBeenCalled(); expect(client.send).toHaveBeenCalledTimes(1);
    expect(store.bulkReadCapacitySnapshot()).toEqual({ active: 0, queued: 0, maxActive: 2, maxWaiters: 32 });
    expect(games.cursors[0].close).toHaveBeenCalledTimes(1);
  } finally { warning.mockRestore(); }
});
