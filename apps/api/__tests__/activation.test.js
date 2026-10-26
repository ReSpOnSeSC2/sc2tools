"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { ActivationService, ACTIVATION_QUERY_MAX_TIME_MS } = require("../src/services/activation");
const { UsersService } = require("../src/services/users");

/** @type {import('mongodb-memory-server').MongoMemoryServer} */ let mongo;
/** @type {import('mongodb').MongoClient} */ let client;
/** @type {ConstructorParameters<typeof ActivationService>[0]} */ let db;
/** @type {ActivationService} */ let activation;
/** @type {UsersService} */ let users;
const at = "2026-10-26T12:00:00.000Z";
const empty = { identity: false, firstGameViewed: false, customBuild: false, checkIn: false,
  overlayLive: false, chatOn: false, goals: [], levelUpDismissedAt: null };
/** @type {Array<[import('mongodb').Document, boolean]>} */
const identityCases = [
  [{ pulseId: " 994428 " }, true], [{ pulseIds: ["", "   ", 12, "x".repeat(65)] }, false],
  [{ pulseIds: [" 2-S2-1-267727 "] }, true], [{ battleTag: " Player#1234 " }, true], [{ battleTag: " " }, false],
];

/** @param {string} [gameId] @param {import('mongodb').Document} [patch] */
function game(gameId = "owned", patch = {}) {
  return { userId: "owner", gameId, date: new Date(at), ...patch };
}

function gate() {
  /** @type {()=>void} */ let release = () => {};
  const promise = new Promise(resolve => { release = () => resolve(undefined); });
  return { promise, release: () => release() };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await new MongoClient(mongo.getUri()).connect();
  const database = client.db("activation");
  db = { users: database.collection("users"), games: database.collection("games"),
    customBuilds: database.collection("customBuilds"), overlayTokens: database.collection("overlayTokens") };
  await db.users.createIndex({ userId: 1 }, { unique: true });
  await db.games.createIndex({ userId: 1, gameId: 1 }, { unique: true });
  await db.games.createIndex({ userId: 1, date: -1 });
  activation = new ActivationService(db); users = new UsersService(db);
});

beforeEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(Object.values(db).map(collection => collection.deleteMany({})));
  await db.users.insertOne({ userId: "owner", clerkUserId: "clerk-owner" });
});

afterAll(async () => { if (client) await client.close(); if (mongo) await mongo.stop(); });

test("successful activation performs exactly six projected bounded reads and no writes", async () => {
  const reads = Object.fromEntries(Object.entries(db).map(([name, collection]) => [name, jest.spyOn(collection, "findOne")]));
  const write = jest.spyOn(db.users, "updateOne");
  expect(await activation.get("owner")).toEqual(empty);
  expect(reads.users).toHaveBeenCalledTimes(3);
  for (const name of ["games", "customBuilds", "overlayTokens"]) expect(reads[name]).toHaveBeenCalledTimes(1);
  for (const spy of Object.values(reads)) for (const [filter, options] of spy.mock.calls) {
    expect(filter.userId).toBe("owner"); expect(options?.projection).toBeTruthy();
    expect(options?.maxTimeMS).toBe(ACTIVATION_QUERY_MAX_TIME_MS);
  }
  expect(reads.users.mock.calls.at(-1)?.[0]).toMatchObject({ _gdprMutation: { $exists: false } });
  expect(write).not.toHaveBeenCalled();
});

test("returns only six flags and normalized onboarding metadata, never private source records", async () => {
  await db.users.updateOne({ userId: "owner" }, { $set: { pulseIds: ["2-S2-1-267727"], battleTag: "Private#1234",
    preferences: { onboarding: { firstGameViewedAt: at, goals: ["stream", "improve"], levelUpDismissedAt: at,
      dismissedAt: "other-field", secret: "do-not-return" }, multichat: { kick: { enabled: true, username: "private-handle" } } } } });
  await db.customBuilds.insertOne({ userId: "owner", enabled: false, slug: "private-build" });
  await db.games.insertOne(game("confirmed", { excluded: true, buildIntent: { status: "confirmed", build: "private-build" } }));
  await db.overlayTokens.insertOne({ userId: "owner", token: "private-token", revokedAt: new Date(at), lastSeenAt: new Date(at) });
  expect(await activation.get("owner")).toEqual({ identity: true, firstGameViewed: true, customBuild: true,
    checkIn: true, overlayLive: true, chatOn: true, goals: ["stream", "improve"], levelUpDismissedAt: at });
});

test.each(identityCases)("identity uses the existing normalized profile shape: %j", async (patch, expected) => {
  await db.users.updateOne({ userId: "owner" }, { $set: patch });
  expect((await activation.get("owner")).identity).toBe(expected);
});

test.each([null, "junk", "2026-02-30T12:00:00.000Z", 1, true])("malformed timestamps never mark a view or dismissal: %j", async value => {
  await db.users.updateOne({ userId: "owner" }, { $set: { "preferences.onboarding": {
    firstGameViewedAt: value, levelUpDismissedAt: value, goals: ["unknown"],
  } } });
  expect(await activation.get("owner")).toEqual(empty);
});

test("BSON dates normalize only to narrow timestamp metadata", async () => {
  await db.users.updateOne({ userId: "owner" }, { $set: { "preferences.onboarding": {
    firstGameViewedAt: new Date(at), levelUpDismissedAt: new Date(at), goals: ["improve", "improve"],
  } } });
  expect(await activation.get("owner")).toMatchObject({ firstGameViewed: true, levelUpDismissedAt: at, goals: ["improve"] });
});

test("other-owner, deleted, pending-delete, resumed and unconfirmed records do not qualify", async () => {
  await db.customBuilds.insertMany([{ userId: "owner", deletedAt: new Date(at) }, { userId: "other" }]);
  await db.overlayTokens.insertMany([{ userId: "owner", lastSeenAt: null }, { userId: "other", lastSeenAt: new Date(at) }]);
  await db.games.insertMany([
    game("pending", { buildIntent: { status: "pending" } }), game("skipped", { buildIntent: { status: "skipped" } }),
    game("deleted", { _deleted: true, buildIntent: { status: "confirmed" } }),
    game("deleting", { _deletionPending: true, buildIntent: { status: "confirmed" } }),
    game("resumed", { isResumedFromReplay: true, buildIntent: { status: "confirmed" } }),
    game("foreign", { userId: "other", buildIntent: { status: "confirmed" } }),
  ]);
  expect(await activation.get("owner")).toEqual(empty);
});

test.each(["twitch", "kick", "youtube", "tiktok"])("only saved boolean true on supported chat platform %s qualifies", async platform => {
  await db.users.updateOne({ userId: "owner" }, { $set: { "preferences.multichat": {
    [platform]: { enabled: "true" }, unknownPlatform: { enabled: true },
  } } });
  expect((await activation.get("owner")).chatOn).toBe(false);
  await db.users.updateOne({ userId: "owner" }, { $set: { [`preferences.multichat.${platform}.enabled`]: true } });
  expect((await activation.get("owner")).chatOn).toBe(true);
});

test("database failure rejects the request instead of manufacturing false flags", async () => {
  jest.spyOn(db.customBuilds, "findOne").mockRejectedValueOnce(new Error("deadline"));
  await expect(activation.get("owner")).rejects.toMatchObject({ status: 503, code: "activation_unavailable" });
});

test.each(["erase", "fence"])("final owner metadata read rejects a delayed %s", async action => {
  const entered = gate(), release = gate(), original = db.users.findOne.bind(db.users);
  jest.spyOn(db.users, "findOne").mockImplementation(async (filter, options) => {
    if (options?.projection?.["preferences.onboarding.firstGameViewedAt"]) { entered.release(); await release.promise; }
    return original(filter, options);
  });
  const pending = activation.get("owner"); await entered.promise;
  if (action === "erase") await db.users.deleteOne({ userId: "owner" });
  else await db.users.updateOne({ userId: "owner" }, { $set: { _gdprMutation: { operation: "erase" } } });
  release.release(); await expect(pending).rejects.toMatchObject({ status: 503, code: "activation_unavailable" });
});

test("confirmed absence query can examine owner history; it retains a deadline rather than limiting recent rows", async () => {
  await db.games.insertMany(Array.from({ length: 80 }, (_, index) => game(`history-${index}`, { buildIntent: { status: "pending" } })));
  await db.games.insertOne(game("foreign", { userId: "other", buildIntent: { status: "confirmed" } }));
  const read = jest.spyOn(db.games, "findOne"); await activation.get("owner");
  const [filter, options] = read.mock.calls[0];
  const explained = await db.games.find(filter, options).limit(1).explain("executionStats");
  expect(explained.executionStats.nReturned).toBe(0);
  expect(explained.executionStats.totalDocsExamined).toBeGreaterThanOrEqual(80);
  expect(options?.maxTimeMS).toBe(ACTIVATION_QUERY_MAX_TIME_MS);
});

test("concurrent first-view attempts write once and preserve unrelated onboarding fields", async () => {
  await db.games.insertOne(game());
  await db.users.updateOne({ userId: "owner" }, { $set: { "preferences.onboarding": {
    goals: ["improve"], dismissedAt: at, levelUpDismissedAt: at, futureField: "$literal-data",
  } } });
  const responses = await Promise.all(Array.from({ length: 8 }, () => users.markFirstGameViewed("owner", "owned")));
  expect(responses).toEqual(Array.from({ length: 8 }, () => ({ firstGameViewed: true })));
  const first = (await db.users.findOne({ userId: "owner" }))?.preferences.onboarding;
  expect(first).toMatchObject({ goals: ["improve"], dismissedAt: at, levelUpDismissedAt: at, futureField: "$literal-data" });
  expect(Number.isFinite(new Date(first.firstGameViewedAt).getTime())).toBe(true);
  await users.markFirstGameViewed("owner", "owned");
  expect((await db.users.findOne({ userId: "owner" }))?.preferences.onboarding).toEqual(first);
});

test("first view uses one exact live-game read and one projected no-upsert conditional owner command", async () => {
  await db.games.insertOne(game());
  const read = jest.spyOn(db.games, "findOne"), write = jest.spyOn(db.users, "findOneAndUpdate");
  const extraRead = jest.spyOn(db.users, "findOne");
  expect(await users.markFirstGameViewed("owner", "owned")).toEqual({ firstGameViewed: true });
  expect(read).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1); expect(extraRead).not.toHaveBeenCalled();
  expect(read.mock.calls[0][0]).toMatchObject({ userId: "owner", gameId: "owned", _deleted: { $ne: true },
    _deletionPending: { $ne: true }, isResumedFromReplay: { $ne: true } });
  expect(write.mock.calls[0][0]).toEqual({ userId: "owner", _gdprMutation: { $exists: false } });
  expect(write.mock.calls[0][2]).toMatchObject({ upsert: false, returnDocument: "after", maxTimeMS: ACTIVATION_QUERY_MAX_TIME_MS,
    projection: { _id: 0, "preferences.onboarding.firstGameViewedAt": 1 } });
});

test.each([{ userId: "other" }, { _deleted: true }, { _deletionPending: true }, { isResumedFromReplay: true }])("first view rejects an ineligible game %j", async patch => {
  await db.games.insertOne(game("ineligible", patch));
  const write = jest.spyOn(db.users, "findOneAndUpdate");
  await expect(users.markFirstGameViewed("owner", "ineligible")).rejects.toMatchObject({ status: 404 });
  expect(write).not.toHaveBeenCalled();
});

test.each(["erase", "fence"])("first view cannot stamp or resurrect an owner after %s", async action => {
  await db.games.insertOne(game());
  if (action === "erase") await db.users.deleteOne({ userId: "owner" });
  else await db.users.updateOne({ userId: "owner" }, { $set: { _gdprMutation: { operation: "erase" } } });
  await expect(users.markFirstGameViewed("owner", "owned")).rejects.toMatchObject({ status: 503 });
  const owner = await db.users.findOne({ userId: "owner" });
  if (action === "erase") expect(owner).toBeNull();
  else expect(owner?.preferences?.onboarding?.firstGameViewedAt).toBeUndefined();
});

test("an existing BSON stamp stays unchanged and a malformed stamp is not silently repaired", async () => {
  await db.games.insertOne(game());
  const existing = new Date(at);
  await db.users.updateOne({ userId: "owner" }, { $set: { "preferences.onboarding.firstGameViewedAt": existing } });
  expect(await users.markFirstGameViewed("owner", "owned")).toEqual({ firstGameViewed: true });
  expect((await db.users.findOne({ userId: "owner" }))?.preferences.onboarding.firstGameViewedAt).toEqual(existing);
  await db.users.updateOne({ userId: "owner" }, { $set: { "preferences.onboarding.firstGameViewedAt": "junk" } });
  await expect(users.markFirstGameViewed("owner", "owned")).rejects.toMatchObject({ status: 503 });
  expect((await db.users.findOne({ userId: "owner" }))?.preferences.onboarding.firstGameViewedAt).toBe("junk");
});
