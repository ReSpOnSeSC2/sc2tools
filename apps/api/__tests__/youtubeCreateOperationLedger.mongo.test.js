// @ts-nocheck
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { MongoClient } = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { buildYoutubeCreateLedger } = require("../src/services/youtubeCreateOperationLedger");

// An absent cached binary skips these contracts rather than downloading one.
const binary = process.env.MONGOMS_SYSTEM_BINARY || path.join(os.homedir(), ".cache", "mongodb-binaries", "mongod-x64-win32-7.0.14.exe");
const suite = fs.existsSync(binary) ? describe : describe.skip;
function request() {
  return { userId: "mock-owner", operationId: randomUUID(), expectedChannelId: "mock-channel",
    intent: { snippet: { title: "Owned event", description: "Desired", categoryId: "20", scheduledStartTime: "2026-10-08T20:00:00Z" },
      status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
      contentDetails: { enableAutoStart: true, enableAutoStop: true, monitorStream: { enableMonitorStream: false } } } };
}
function candidate(context, id) {
  return { id, snippet: { ...context.intent.snippet, description: context.intent.snippet.description + context.marker, channelId: context.expectedChannelId },
    status: { ...context.intent.status, lifeCycleStatus: "created" }, contentDetails: context.intent.contentDetails };
}

suite("actual MongoDB ledger operator contracts (cached local binary only)", () => {
  let server, client, collection, cacheRoot, dbPath;
  beforeAll(async () => {
    process.env.MONGOMS_RUNTIME_DOWNLOAD = "false";
    cacheRoot = path.resolve(__dirname, "..", ".cache", "youtube-ledger-mongo-tests");
    fs.mkdirSync(cacheRoot, { recursive: true });
    dbPath = fs.mkdtempSync(path.join(cacheRoot, "contract-"));
    server = await MongoMemoryServer.create({ binary: { systemBinary: binary, version: "7.0.14" }, instance: { dbPath, storageEngine: "wiredTiger" }, spawn: { windowsHide: true } });
    client = new MongoClient(server.getUri(), { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    collection = client.db("mock_youtube_ledger").collection("operations");
  }, 30_000);
  afterAll(async () => {
    if (client) await client.close();
    if (server) await server.stop();
    if (dbPath) {
      const target = path.resolve(dbPath);
      if (!target.startsWith(cacheRoot + path.sep) || path.dirname(target) !== cacheRoot) throw new Error("Unexpected test DB cleanup target.");
      fs.rmSync(target, { recursive: true, force: true });
    }
  }, 30_000);
  beforeEach(async () => { await collection.deleteMany({}); });

  test("concurrent same UUID performs exactly one insert and creates valid indexes", async () => {
    const ledger = buildYoutubeCreateLedger({ collection });
    await ledger.ensureIndexes();
    const args = request(); let calls = 0;
    const results = await Promise.all(Array.from({ length: 12 }, () => buildYoutubeCreateLedger({ collection }).execute(args, async (context) => { calls++; return candidate(context, "owned-one"); })));
    expect(calls).toBe(1);
    expect(results.some((result) => result.phase === "succeeded")).toBe(true);
    expect(await collection.countDocuments({ kind: "operation" })).toBe(1);
    expect(await collection.countDocuments({ _schemaVersion: 1 })).toBe(3);
    expect((await ledger.execute(args, async () => { throw Error("No replay insert"); })).broadcast.id).toBe("owned-one");
    const indexes = await collection.indexes();
    expect(indexes.find((index) => index.name === "youtube_create_user_operation").unique).toBe(true);
    expect(indexes.filter((index) => index.expireAfterSeconds !== undefined).map((index) => index.key)).toEqual([{ dailyExpiresAt: 1 }]);
  });

  test("concurrent distinct UUIDs share an atomic daily admission cap", async () => {
    let calls = 0;
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => {
      const args = request();
      return buildYoutubeCreateLedger({ collection, maxDailyOperationsPerUser: 3 }).execute(args, async (context) => { calls++; return candidate(context, args.operationId); });
    }));
    expect(calls).toBe(3);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(await collection.countDocuments({ kind: "operation" })).toBe(3);
    expect((await collection.findOne({ kind: "daily_quota" })).count).toBe(3);
    expect((await collection.findOne({ kind: "quota" })).count).toBe(3);
  });

  test("different broadcasts cannot reserve the same stream until owned terminal proof", async () => {
    const ledger = buildYoutubeCreateLedger({ collection });
    const first = request(), second = request();
    await ledger.execute(first, async (context) => candidate(context, "owned-one"));
    await ledger.execute(second, async (context) => candidate(context, "owned-two"));
    const base = { userId: first.userId, expectedChannelId: first.expectedChannelId, streamId: "fixed-reusable-stream" };
    const results = await Promise.allSettled(["owned-one", "owned-two"].map((broadcastId) => buildYoutubeCreateLedger({ collection }).claimStream({ ...base, broadcastId }, async () => false)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const reservation = await collection.findOne({ kind: "stream_claim" });
    expect(reservation._schemaVersion).toBe(1);
    const nextId = reservation.broadcastId === "owned-one" ? "owned-two" : "owned-one";
    await expect(ledger.claimStream({ ...base, broadcastId: nextId }, async () => false)).rejects.toMatchObject({ code: "youtube_stream_reserved" });
    await expect(ledger.claimStream({ ...base, broadcastId: nextId }, async (previousId) => previousId === reservation.broadcastId)).resolves.toBe(true);
    expect((await collection.findOne({ kind: "stream_claim" })).broadcastId).toBe(nextId);
  });
});
