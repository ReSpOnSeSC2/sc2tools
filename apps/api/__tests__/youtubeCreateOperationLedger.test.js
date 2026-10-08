// @ts-nocheck
"use strict";

// These network-free tests run under the repository's Jest runner or directly
// with `node --test`; no MongoDB daemon or external provider is contacted.
const testCase = globalThis.test || require("node:test").test;
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { buildYoutubeCreateLedger } = require("../src/services/youtubeCreateOperationLedger");
const { YoutubeStreamingService } = require("../src/services/youtubeStreaming");
const { COLLECTIONS } = require("../src/config/constants");
const { expectedVersion, VERSION_KEY } = require("../src/db/schemaVersioning");

// JSON fixtures stay in the Jest VM realm; structuredClone returns host-realm
// prototypes and would exercise class rejection instead of intent identity.
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function get(row, key) { return key.split(".").reduce((value, part) => value?.[part], row); }
function set(row, key, value) {
  const parts = key.split(".");
  let current = row;
  for (const part of parts.slice(0, -1)) current = current[part] ||= {};
  current[parts.at(-1)] = clone(value);
}
function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((branch) => matches(row, branch));
    const value = get(row, key);
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("$in" in expected) return expected.$in.includes(value);
      if ("$lt" in expected) return value < expected.$lt;
      if ("$ne" in expected) return Array.isArray(value)
        ? !value.includes(expected.$ne) : value !== expected.$ne;
      if ("$exists" in expected) return (value !== undefined) === expected.$exists;
    }
    return value === expected;
  });
}
class AtomicMemoryCollection {
  rows = new Map();
  indexes = [];
  failInsertBeforeWrite = false;
  failInsertAfterWrite = false;
  failQuotaAfterWrite = false;
  failCommitAfterWrite = false;
  async createIndex(keys, opts) { this.indexes.push({ keys, opts }); return opts.name; }
  async findOne(filter) { return clone([...this.rows.values()].find((row) => matches(row, filter)) || null); }
  async insertOne(row, options) {
    assert.equal(options.writeConcern.w, "majority");
    if (this.failInsertBeforeWrite) { this.failInsertBeforeWrite = false; throw Error("database unavailable"); }
    if (this.rows.has(row._id)) throw Object.assign(Error("duplicate"), { code: 11000 });
    this.rows.set(row._id, clone(row));
    if (this.failInsertAfterWrite) { this.failInsertAfterWrite = false; throw Error("acknowledgement lost"); }
    return { acknowledged: true };
  }
  async updateOne(filter, update, options) {
    assert.equal(options.writeConcern.w, "majority");
    let row = [...this.rows.values()].find((item) => matches(item, filter));
    let added = false;
    if (!row && options.upsert) {
      if (this.rows.has(filter._id)) throw Object.assign(Error("duplicate"), { code: 11000 });
      row = { _id: filter._id, ...clone(update.$setOnInsert) };
      this.rows.set(row._id, row); added = true;
    }
    if (!row) return { matchedCount: 0, modifiedCount: 0 };
    for (const [key, value] of Object.entries(update.$set || {})) set(row, key, value);
    for (const [key, value] of Object.entries(update.$inc || {})) set(row, key, get(row, key) + value);
    for (const [key, value] of Object.entries(update.$push || {})) row[key].push(clone(value));
    for (const key of Object.keys(update.$unset || {})) delete row[key];
    if (update.$push && this.failQuotaAfterWrite) {
      this.failQuotaAfterWrite = false; throw Error("quota acknowledgement lost");
    }
    if (update.$set?.phase === "succeeded" && this.failCommitAfterWrite) {
      this.failCommitAfterWrite = false; throw Error("commit acknowledgement lost");
    }
    return { matchedCount: added ? 0 : 1, modifiedCount: 1, upsertedCount: added ? 1 : 0 };
  }
}
function args(overrides = {}) {
  return {
    userId: "user-one", operationId: randomUUID(), expectedChannelId: "UC_owned",
    intent: {
      snippet: { title: "Live match", description: "Desired description", categoryId: "20", scheduledStartTime: "2026-10-08T20:00:00Z" },
      status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
      contentDetails: { enableAutoStart: true, enableAutoStop: true, monitorStream: { enableMonitorStream: false } },
    },
    ...overrides,
  };
}
function candidate(context, id = "own_video") {
  const result = clone(context.intent);
  result.id = id;
  result.snippet.channelId = context.expectedChannelId;
  result.snippet.description += context.marker;
  result.status.lifeCycleStatus = "created";
  result.cdn = { ingestionInfo: { streamName: "must-never-escape" } };
  return result;
}
function setup(options = {}) {
  const collection = new AtomicMemoryCollection();
  return { collection, ledger: buildYoutubeCreateLedger({ collection, ...options }) };
}

testCase("fresh ledger kinds carry schema metadata without changing provider payload or request identity", async () => {
  const { collection, ledger } = setup();
  const request = args(), originalIntent = clone(request.intent);
  let providerContext;
  const result = await ledger.execute(request, async (context) => {
    providerContext = context; return candidate(context);
  });
  await ledger.claimStream({ userId: request.userId, expectedChannelId: request.expectedChannelId,
    broadcastId: result.broadcast.id, streamId: "reusable-stream" }, async () => false);
  const rows = [...collection.rows.values()];
  assert.deepEqual(rows.map((row) => row.kind).sort(), ["daily_quota", "operation", "quota", "stream_claim"]);
  for (const row of rows) assert.equal(row[VERSION_KEY], expectedVersion(COLLECTIONS.YOUTUBE_CREATE_OPERATIONS));
  assert.deepEqual(request.intent, originalIntent);
  assert.deepEqual(clone(providerContext.intent), originalIntent);
  assert.equal(providerContext[VERSION_KEY], undefined);
  assert.equal(result[VERSION_KEY], undefined);
  const operation = rows.find((row) => row.kind === "operation");
  const permanentQuota = rows.find((row) => row.kind === "quota");
  assert.equal(permanentQuota.intentHashes[request.operationId], operation.intentHash);
  assert.equal((await ledger.execute(request, async () => { throw Error("No repeated provider insert"); })).broadcast.id, result.broadcast.id);
});

testCase("unstamped initial v1 operations retain uncertainty, recover by marker, and never reinsert", async () => {
  const { collection, ledger } = setup();
  const request = args(); let providerContext, inserts = 0;
  const first = await ledger.execute(request, async (context) => {
    inserts++; providerContext = context; throw Error("Unknown provider outcome");
  });
  assert.equal(first.phase, "uncertain");
  for (const row of collection.rows.values()) delete row[VERSION_KEY];
  const originalRows = clone([...collection.rows.values()]);
  const restarted = buildYoutubeCreateLedger({ collection });
  assert.equal((await restarted.execute(request, async () => { inserts++; })).phase, "uncertain");
  assert.deepEqual(clone([...collection.rows.values()]), originalRows);
  const recovered = await restarted.reconcile(request, async (context) => {
    assert.deepEqual(context, providerContext); return [candidate(context)];
  });
  assert.equal(recovered.phase, "succeeded");
  assert.equal((await restarted.execute(request, async () => { inserts++; })).broadcast.id, recovered.broadcast.id);
  assert.equal(inserts, 1);
  assert.equal([...collection.rows.values()].find((row) => row.kind === "quota").count, 1);
});

testCase("atomic daily admission caps new operations, replays count once and next day opens new slots", async () => {
  let now = Date.parse("2026-10-08T00:00:00Z");
  const { collection, ledger } = setup({ now: () => now, maxDailyOperationsPerUser: 2 });
  const first = args(), second = args(), third = args();
  let inserts = 0;
  await Promise.all([first, second].map((request) => ledger.execute(request, async (context) => { inserts++; return candidate(context, request.operationId); })));
  await ledger.execute(first, async () => { throw Error("must not repeat"); });
  await assert.rejects(ledger.execute(third, async () => { inserts++; }), { code: "youtube_daily_operation_limit", status: 429 });
  assert.equal(inserts, 2);
  assert.equal([...collection.rows.values()].find((row) => row.kind === "daily_quota").count, 2);
  now += 24 * 60 * 60_000;
  await ledger.execute(third, async (context) => { inserts++; return candidate(context, third.operationId); });
  assert.equal(inserts, 3);
  assert.equal([...collection.rows.values()].find((row) => row.kind === "quota").count, 3);
});

testCase("parallel daily cap across service instances permits one new insert", async () => {
  const { collection, ledger } = setup({ maxDailyOperationsPerUser: 1 });
  const other = buildYoutubeCreateLedger({ collection, maxDailyOperationsPerUser: 1 });
  let inserts = 0;
  const results = await Promise.allSettled([ledger, other].map((instance) => instance.execute(args(), async (context) => { inserts++; return candidate(context, randomUUID()); })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(inserts, 1);
});

testCase("stream claims serialize different devices and reclaim only after verified terminal proof", async () => {
  const { collection, ledger } = setup();
  const other = buildYoutubeCreateLedger({ collection });
  const one = args(), two = args(), three = args();
  await ledger.execute(one, async (context) => candidate(context, "owned-one"));
  await ledger.execute(two, async (context) => candidate(context, "owned-two"));
  await ledger.execute(three, async (context) => candidate(context, "owned-three"));
  const claim = { userId: one.userId, expectedChannelId: one.expectedChannelId, streamId: "reusable-stream", broadcastId: "owned-one" };
  assert.equal(await ledger.claimStream(claim, async () => false), true);
  assert.equal(await other.claimStream(claim, async () => { throw Error("same ID needs no release"); }), true);
  await assert.rejects(other.claimStream({ ...claim, broadcastId: "owned-two" }, async () => false), { code: "youtube_stream_reserved" });
  const gate = deferred();
  const attempts = ["owned-two", "owned-three"].map((broadcastId) => other.claimStream({ ...claim, broadcastId }, async (previous) => { await gate.promise; return previous === "owned-one"; }));
  gate.resolve();
  const results = await Promise.allSettled(attempts);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

testCase("two server instances race one UUID and only the durable winner inserts", async () => {
  const { collection, ledger } = setup();
  const other = buildYoutubeCreateLedger({ collection });
  const request = args();
  const entered = deferred(); const release = deferred();
  let insertCount = 0;
  const insert = async (context) => { insertCount++; entered.resolve(); await release.promise; return candidate(context); };
  const first = ledger.execute(request, insert);
  await entered.promise;
  const repeated = await other.execute(request, insert);
  assert.equal(repeated.phase, "uncertain");
  release.resolve();
  assert.equal((await first).phase, "succeeded");
  assert.equal(insertCount, 1);
  assert.equal([...collection.rows.values()].find((row) => row.kind === "quota").count, 1);
});

testCase("simultaneous first requests with reordered body keys still insert once", async () => {
  const { collection, ledger } = setup();
  const request = args(); let inserts = 0;
  const reordered = clone(request);
  reordered.intent = { contentDetails: request.intent.contentDetails, status: request.intent.status, snippet: request.intent.snippet };
  await Promise.all([
    ledger.execute(request, async (context) => { inserts++; return candidate(context); }),
    buildYoutubeCreateLedger({ collection }).execute(reordered, async (context) => { inserts++; return candidate(context); }),
  ]);
  assert.equal(inserts, 1);
});

testCase("success replay exposes only safe owned fields, never nonce or credentials", async () => {
  const { ledger } = setup(); const request = args();
  const result = await ledger.execute(request, async (context) => candidate(context));
  const replay = await ledger.execute(request, async () => { throw Error("must not run"); });
  assert.deepEqual(replay, result);
  assert.equal(result.broadcast.snippet.description, request.intent.snippet.description);
  assert.equal(result.broadcast.status.selfDeclaredMadeForKids, false);
  assert.equal(result.broadcast.snippet.categoryId, "20");
  assert.equal(result.broadcast.contentDetails.monitorStream.enableMonitorStream, false);
  assert.equal(JSON.stringify(result).includes("SC2Tools:"), false);
  assert.equal(JSON.stringify(result).includes("must-never-escape"), false);
  result.broadcast.snippet.title = "caller mutation";
  assert.equal((await ledger.inspect(request)).broadcast.snippet.title, "Live match");
});

testCase("same UUID rejects a different body or channel without provider call", async () => {
  const { ledger } = setup(); const request = args();
  await ledger.execute(request, async (context) => candidate(context));
  for (const altered of [
    { ...request, intent: { ...request.intent, snippet: { ...request.intent.snippet, title: "Changed" } } },
    { ...request, expectedChannelId: "UC_other" },
  ]) {
    await assert.rejects(ledger.execute(altered, async () => { throw Error("no"); }), { code: "youtube_operation_intent_conflict" });
  }
});

testCase("ambiguous provider failure never retries insert even years later", async () => {
  let now = 1000; const { collection, ledger } = setup({ now: () => now });
  const request = args(); let inserts = 0;
  const result = await ledger.execute(request, async () => { inserts++; throw Error("private provider response"); });
  assert.equal(result.phase, "uncertain");
  now += 20 * 365 * 86_400_000;
  assert.equal((await buildYoutubeCreateLedger({ collection, now: () => now }).execute(request, async () => { inserts++; })).phase, "uncertain");
  assert.equal(inserts, 1);
  assert.equal(JSON.stringify(result).includes("private provider"), false);
});

testCase("lost durable intent acknowledgement cannot reach Google or allow replay", async () => {
  const { collection, ledger } = setup(); const request = args(); let inserts = 0;
  collection.failInsertAfterWrite = true;
  await assert.rejects(ledger.execute(request, async () => { inserts++; }));
  const replay = await ledger.execute(request, async () => { inserts++; });
  assert.equal(replay.phase, "uncertain"); assert.equal(inserts, 0);
});

testCase("failed pre-insert storage allows same-intent retry because Google was never called", async () => {
  const { collection, ledger } = setup(); const request = args(); let inserts = 0;
  collection.failInsertBeforeWrite = true;
  await assert.rejects(ledger.execute(request, async () => { inserts++; }));
  const altered = clone(request); altered.intent.snippet.title = "Changed";
  await assert.rejects(ledger.execute(altered, async () => { inserts++; }), { code: "youtube_operation_intent_conflict" });
  assert.equal((await ledger.execute(request, async (context) => { inserts++; return candidate(context); })).phase, "succeeded");
  assert.equal(inserts, 1);
});

testCase("lost quota acknowledgement reserves body identity and counts only once", async () => {
  const { collection, ledger } = setup(); const request = args();
  collection.failQuotaAfterWrite = true;
  await assert.rejects(ledger.execute(request, async () => { throw Error("no"); }));
  const changed = clone(request); changed.intent.snippet.description = "Different";
  await assert.rejects(ledger.execute(changed, async () => {}), { code: "youtube_operation_intent_conflict" });
  await ledger.execute(request, async (context) => candidate(context));
  assert.equal([...collection.rows.values()].find((row) => row.kind === "quota").count, 1);
});

testCase("lost commit acknowledgement returns the already durable success", async () => {
  const { collection, ledger } = setup(); const request = args(); let inserts = 0;
  collection.failCommitAfterWrite = true;
  const result = await ledger.execute(request, async (context) => { inserts++; return candidate(context); });
  assert.equal(result.phase, "succeeded");
  await ledger.execute(request, async () => { inserts++; });
  assert.equal(inserts, 1);
});

testCase("uncertain creation reconciles exactly one nonce and body without insertion", async () => {
  const { ledger } = setup(); const request = args(); let privateContext;
  await ledger.execute(request, async (context) => { privateContext = context; throw Error("lost response"); });
  const result = await ledger.reconcile(request, async (context) => {
    assert.equal(context.nonce.length, 32);
    assert.equal(Buffer.byteLength(context.marker), 46);
    return [candidate(context), candidate(context)];
  });
  assert.equal(result.phase, "succeeded");
  assert.equal(result.broadcast.id, "own_video");
  assert.equal(JSON.stringify(result).includes(privateContext.nonce), false);
  assert.equal((await ledger.execute(request, async () => { throw Error("never retry"); })).phase, "succeeded");
});

testCase("reconciliation rejects foreign identity or near-matching nonce/body", async () => {
  const { ledger } = setup(); const request = args();
  await ledger.execute(request, async () => { throw Error("uncertain"); });
  const alterations = [
    (row) => { row.snippet.channelId = "UC_foreign"; },
    (row) => { row.snippet.description += "extra"; },
    (row) => { row.snippet.title = "Different"; },
    (row) => { row.snippet.scheduledStartTime = "2026-10-09T20:00:00Z"; },
    (row) => { row.status.privacyStatus = "public"; },
    (row) => { row.contentDetails.enableAutoStop = false; },
  ];
  for (const alter of alterations) {
    const result = await ledger.reconcile(request, async (context) => { const row = candidate(context); alter(row); return [row]; });
    assert.equal(result.phase, "uncertain");
  }
});

testCase("two distinct exact nonce matches stay uncertain rather than choosing first", async () => {
  const { ledger } = setup(); const request = args();
  await ledger.execute(request, async () => { throw Error("uncertain"); });
  const result = await ledger.reconcile(request, async (context) => [candidate(context, "video_one"), candidate(context, "video_two")]);
  assert.equal(result.phase, "uncertain");
});

testCase("unverified success response stays uncertain and never proves ownership", async () => {
  const { ledger } = setup(); const request = args();
  const result = await ledger.execute(request, async (context) => { const row = candidate(context); delete row.snippet.channelId; return row; });
  assert.equal(result.phase, "uncertain");
  assert.equal(await ledger.getOwnedBroadcast({ userId: request.userId, broadcastId: "own_video", expectedChannelId: request.expectedChannelId }), null);
});

testCase("ownership proof requires succeeded ledger, same user, same owned channel", async () => {
  const { ledger } = setup(); const request = args();
  await ledger.execute(request, async (context) => candidate(context));
  const owned = { userId: request.userId, broadcastId: "own_video", expectedChannelId: request.expectedChannelId };
  assert.equal((await ledger.getOwnedBroadcast(owned)).id, "own_video");
  assert.equal(await ledger.getOwnedBroadcast({ ...owned, userId: "other-user" }), null);
  assert.equal(await ledger.getOwnedBroadcast({ ...owned, expectedChannelId: "UC_other" }), null);
  assert.equal(await ledger.getOwnedBroadcast({ ...owned, broadcastId: "unrecorded" }), null);
});

testCase("bounded capacity never evicts uncertainty; admitted retries survive full quota", async () => {
  const { collection, ledger } = setup({ maxOperationsPerUser: 2 });
  const uncertain = args(); const success = args();
  await ledger.execute(uncertain, async () => { throw Error("lost"); });
  await ledger.execute(success, async (context) => candidate(context));
  await assert.rejects(ledger.execute(args(), async () => {}), { code: "youtube_operation_capacity_reached" });
  assert.equal((await ledger.execute(uncertain, async () => { throw Error("no"); })).phase, "uncertain");
  assert.equal((await ledger.execute(success, async () => { throw Error("no"); })).phase, "succeeded");
  assert.equal([...collection.rows.values()].filter((row) => row.kind === "operation").length, 2);
  await ledger.ensureIndexes();
  assert.equal(collection.indexes.filter(({ opts }) => "expireAfterSeconds" in opts).length, 1);
  assert.deepEqual(collection.indexes.find(({ opts }) => "expireAfterSeconds" in opts).keys, { dailyExpiresAt: 1 });
});

testCase("user quotas and UUIDs are isolated; provider markers are independent", async () => {
  const { ledger } = setup({ maxOperationsPerUser: 1 }); const first = args();
  const contexts = [];
  for (const request of [first, { ...first, userId: "another-user", expectedChannelId: "UC_another" }]) {
    const result = await ledger.execute(request, async (context) => { contexts.push(context); return candidate(context); });
    assert.equal(result.phase, "succeeded");
  }
  assert.notEqual(contexts[0].nonce, contexts[1].nonce);
});

testCase("overlong marker description and malformed UUID never consume admission", async () => {
  const { collection, ledger } = setup();
  const request = args(); request.intent.snippet.description = "é".repeat(2478);
  await assert.rejects(ledger.execute(request, async () => {}), { code: "youtube_description_marker_too_large" });
  await assert.rejects(ledger.execute(args({ operationId: "invalid" }), async () => {}), { code: "youtube_operation_invalid" });
  assert.equal(collection.rows.size, 0);
});

testCase("Google timestamp normalization remains the same scheduled instant", async () => {
  const { ledger } = setup(); const request = args();
  request.intent.snippet.scheduledStartTime = "2026-10-08T16:00:00-04:00";
  const result = await ledger.execute(request, async (context) => {
    const row = candidate(context); row.snippet.scheduledStartTime = "2026-10-08T20:00:00.000Z"; return row;
  });
  assert.equal(result.phase, "succeeded");
});

testCase("existing fractional intent recovers Google's whole second without changing its hash or reinserting", async () => {
  const { collection, ledger } = setup(), request = args();
  request.intent.snippet.scheduledStartTime = "2026-10-08T20:00:00.961Z";
  let inserts = 0;
  await ledger.execute(request, async () => { inserts++; throw Error("lost provider response"); });
  const stored = [...collection.rows.values()].find((row) => row.kind === "operation");
  const hash = stored.intentHash;
  const result = await ledger.reconcile(request, async (context) => {
    const row = candidate(context); row.snippet.scheduledStartTime = "2026-10-08T20:00:00Z"; return [row];
  });
  assert.equal(result.phase, "succeeded");
  assert.equal(result.broadcast.snippet.scheduledStartTime, "2026-10-08T20:00:00Z");
  assert.equal(stored.intentHash, hash);
  assert.equal(stored.intent.snippet.scheduledStartTime, request.intent.snippet.scheduledStartTime);
  assert.equal((await ledger.execute(request, async () => { inserts++; })).phase, "succeeded");
  assert.equal(inserts, 1);
});

testCase("second precision cannot reconcile a different UTC second or replace the reserved operation", async () => {
  const { ledger } = setup(), request = args();
  request.intent.snippet.scheduledStartTime = "2026-10-08T20:00:00.961Z";
  let inserts = 0;
  await ledger.execute(request, async () => { inserts++; throw Error("lost provider response"); });
  const result = await ledger.reconcile(request, async (context) => {
    const row = candidate(context); row.snippet.scheduledStartTime = "2026-10-08T20:00:01Z"; return [row];
  });
  assert.equal(result.phase, "uncertain");
  assert.equal((await ledger.execute(request, async () => { inserts++; })).phase, "uncertain");
  assert.equal(inserts, 1);
});

testCase("service recovery scans complete unfinished inventories then verifies the exact nonce with the real ledger", async () => {
  const { ledger } = setup(), request = args(), inventory = [], calls = [];
  let own, inserts = 0;
  await ledger.execute(request, async (context) => {
    own = candidate(context); inserts++; throw Error("lost provider response");
  });
  for (let n = 0; n < 250; n++) inventory.push({ ...clone(own), id: "archive_" + n,
    snippet: { ...own.snippet, description: "Historical event" }, status: { ...own.status, lifeCycleStatus: "complete" } });
  for (let n = 0; n < 120; n++) inventory.push({ ...clone(own), id: "active_" + n,
    snippet: { ...own.snippet, description: "Another live event" }, status: { ...own.status, lifeCycleStatus: "live" } });
  for (let n = 0; n < 90; n++) inventory.push({ ...clone(own), id: "upcoming_" + n,
    snippet: { ...own.snippet, description: "Another upcoming event" } });
  inventory.push(own);
  const integrations = { withStreamingGrant: async (_user, _platform, action) => action({
    platformUserId: request.expectedChannelId, accessToken: "synthetic-token", assertCurrent: async () => {},
    boundedFetch: async (raw, options) => {
      const url = new URL(raw), status = url.searchParams.get("broadcastStatus");
      assert.equal(options.method, "GET"); assert.equal(url.searchParams.has("mine"), false);
      calls.push(status);
      const matches = inventory.filter((row) => status === "active" ? row.status.lifeCycleStatus === "live" : row.status.lifeCycleStatus === "created");
      const start = Number(url.searchParams.get("pageToken") || 0);
      const result = { items: matches.slice(start, start + 50), ...(start + 50 < matches.length ? { nextPageToken: String(start + 50) } : {}) };
      return { ok: true, text: async () => JSON.stringify(result) };
    },
  }) };
  const service = new YoutubeStreamingService({ integrations, ledger });
  const result = await service.read(request.userId, "recover_create", { operation_id: request.operationId });
  assert.equal(result.id, own.id);
  assert.deepEqual(calls, ["active", "active", "active", "upcoming", "upcoming"]);
  assert.equal(result.snippet.description, request.intent.snippet.description);
  assert.equal(JSON.stringify(result).includes("SC2Tools:"), false);
  assert.equal(inserts, 1);
});

testCase("service recovery keeps distinct nonce matches and conflicting cross-filter duplicates uncertain", async () => {
  for (const sameId of [false, true]) {
    const { ledger } = setup(), request = args();
    let own, inserts = 0;
    await ledger.execute(request, async (context) => { own = candidate(context); inserts++; throw Error("lost response"); });
    const integrations = { withStreamingGrant: async (_user, _platform, action) => action({
      platformUserId: request.expectedChannelId, accessToken: "synthetic-token", assertCurrent: async () => {},
      boundedFetch: async (raw) => {
        const active = new URL(raw).searchParams.get("broadcastStatus") === "active";
        const row = { ...clone(own), id: active || sameId ? "first_match" : "second_match",
          status: { ...own.status, lifeCycleStatus: active ? "live" : "created" } };
        return { ok: true, text: async () => JSON.stringify({ items: [row] }) };
      },
    }) };
    const service = new YoutubeStreamingService({ integrations, ledger });
    await assert.rejects(service.read(request.userId, "recover_create", { operation_id: request.operationId }),
      { code: sameId ? "youtube_inventory_unknown" : "creation_uncertain" });
    assert.equal((await ledger.execute(request, async () => { inserts++; })).phase, "uncertain");
    assert.equal(inserts, 1);
  }
});

testCase("bind selection persists before provider call, without fabricating a completed binding", async () => {
  const { ledger } = setup(); const request = args();
  await ledger.execute(request, async (context) => candidate(context));
  const binding = { userId: request.userId, broadcastId: "own_video", expectedChannelId: request.expectedChannelId, streamId: "reusable_one" };
  const pinned = await ledger.markBound(binding);
  assert.equal(pinned.selectedStreamId, "reusable_one");
  assert.equal(pinned.contentDetails.boundStreamId, undefined);
  const fresh = clone(pinned); fresh.contentDetails.boundStreamId = "reusable_one";
  const bound = await ledger.markBound({ ...binding, broadcast: fresh });
  assert.equal(bound.contentDetails.boundStreamId, "reusable_one");
  await assert.rejects(ledger.markBound({ ...binding, streamId: "reusable_two" }), { code: "youtube_broadcast_stream_conflict" });
});

testCase("different server instances race bind selections and one permanent pin wins", async () => {
  const { collection, ledger } = setup(); const request = args();
  await ledger.execute(request, async (context) => candidate(context));
  const base = { userId: request.userId, broadcastId: "own_video", expectedChannelId: request.expectedChannelId };
  const results = await Promise.allSettled([
    ledger.markBound({ ...base, streamId: "stream_a" }),
    buildYoutubeCreateLedger({ collection }).markBound({ ...base, streamId: "stream_b" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.ok(["stream_a", "stream_b"].includes((await ledger.getOwnedBroadcast(base)).selectedStreamId));
});

testCase("bind proof rejects foreign or mismatched provider rows without changing pin", async () => {
  const { ledger } = setup(); const request = args();
  await ledger.execute(request, async (context) => candidate(context));
  const base = { userId: request.userId, broadcastId: "own_video", expectedChannelId: request.expectedChannelId, streamId: "chosen" };
  for (const broadcast of [
    { id: "other", snippet: { channelId: request.expectedChannelId } },
    { id: "own_video", snippet: { channelId: "foreign" } },
    { id: "own_video", snippet: { channelId: request.expectedChannelId }, contentDetails: { boundStreamId: "another" } },
  ]) {
    await assert.rejects(ledger.markBound({ ...base, broadcast }), { code: "youtube_bound_broadcast_unverified" });
  }
  assert.equal((await ledger.getOwnedBroadcast(base)).selectedStreamId, undefined);
});

testCase("fresh owned rows strip only their exact nonce and signal metadata cleanup", async () => {
  const { ledger } = setup(); const request = args(); let actual;
  await ledger.execute(request, async (context) => { actual = candidate(context); return actual; });
  await ledger.markBound({ userId: request.userId, broadcastId: actual.id, expectedChannelId: request.expectedChannelId, streamId: "pinned" });
  actual.snippet.title = "Title edited on YouTube";
  actual.status.lifeCycleStatus = "live";
  actual.contentDetails.boundStreamId = "pinned";
  const result = await ledger.sanitizeOwnedBroadcast({ userId: request.userId, expectedChannelId: request.expectedChannelId, broadcast: actual });
  assert.equal(result.snippet.title, "Title edited on YouTube");
  assert.equal(result.snippet.description, request.intent.snippet.description);
  assert.equal(result.metadataPending, true);
  assert.equal(result.status.lifeCycleStatus, "live");
  assert.equal(result.contentDetails.boundStreamId, "pinned");
  assert.equal(result.status.selfDeclaredMadeForKids, false);
  assert.equal(result.contentDetails.monitorStream.enableMonitorStream, false);
  assert.equal(result.selectedStreamId, undefined);
  assert.equal(result.cdn, undefined);
  assert.equal(JSON.stringify(result).includes("SC2Tools:"), false);
});

testCase("clean fresh owned descriptions are unchanged and do not claim pending cleanup", async () => {
  const { ledger } = setup(); const request = args(); let actual;
  await ledger.execute(request, async (context) => { actual = candidate(context); return actual; });
  const description = "User edited description\n\n[SC2Tools: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa]";
  actual.snippet.description = description;
  const result = await ledger.sanitizeOwnedBroadcast({ userId: request.userId, expectedChannelId: request.expectedChannelId, broadcast: actual });
  assert.equal(result.snippet.description, description);
  assert.equal("metadataPending" in result, false);
});

testCase("nonce sanitizer rejects foreign IDs, channels, and sessions before rewriting", async () => {
  const { ledger } = setup(); const request = args(); let actual;
  await ledger.execute(request, async (context) => { actual = candidate(context); return actual; });
  const base = { userId: request.userId, expectedChannelId: request.expectedChannelId, broadcast: actual };
  for (const wrong of [
    { ...base, userId: "another-user" },
    { ...base, expectedChannelId: "UC_other" },
    { ...base, broadcast: { ...actual, id: "another-video" } },
  ]) {
    await assert.rejects(ledger.sanitizeOwnedBroadcast(wrong), { code: "youtube_broadcast_not_owned" });
  }
  assert.equal(actual.snippet.description.includes("SC2Tools:"), true);
});

testCase("trusted recovery can omit intent but only loads its exact stored owned operation", async () => {
  const { ledger } = setup(); const request = args();
  await ledger.execute(request, async () => { throw Error("uncertain"); });
  const identity = { userId: request.userId, operationId: request.operationId, expectedChannelId: request.expectedChannelId };
  assert.equal(await ledger.reconcile({ ...identity, operationId: randomUUID() }, async () => { throw Error("must not list"); }), null);
  assert.equal(await ledger.reconcile({ ...identity, userId: "another-user" }, async () => { throw Error("must not list"); }), null);
  await assert.rejects(ledger.reconcile({ ...identity, expectedChannelId: "UC_foreign" }, async () => {}), { code: "youtube_operation_intent_conflict" });
  const result = await ledger.reconcile(identity, async (context) => {
    assert.deepEqual(clone(context.intent), request.intent); return [candidate(context)];
  });
  assert.equal(result.phase, "succeeded");
});
