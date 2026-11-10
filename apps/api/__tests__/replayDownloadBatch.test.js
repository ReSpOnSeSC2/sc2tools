// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient, Double } = require("mongodb");
const { ReplayFilesService } = require("../src/services/replayFiles");
const { REPLAY_DOWNLOAD_COMMENT } = require("../src/middleware/replayDownloadBatchBoundary");
const SHA = "a".repeat(64), MD5 = "AAAAAAAAAAAAAAAAAAAAAA==", OTHER_MD5 = "AQEBAQEBAQEBAQEBAQEBAQ==";
const STAMP = new Date("2026-11-02T00:00:00.000Z");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const marker = extra => ({ version: 1, uploadId: "originalUploadId123456789", sizeBytes: 8, sha256: SHA, md5: MD5, storedAt: new Date(STAMP), ...extra });
let mongo, client, games, sequence = 0;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); games = client.db("replay-download-batch").collection("games"); });
afterAll(async () => { await client?.close(); await mongo?.stop(); });
afterEach(() => jest.restoreAllMocks());
async function seed(extra = {}) {
  const gameId = `game-${++sequence}`;
  await games.insertOne({ userId: "owner-a", gameId, date: STAMP, map: "Map", opponent: { displayName: "Opponent" }, replayFile: marker(), ...extra });
  return gameId;
}
function store(send = async () => ({ ContentLength: 8, Metadata: { sha256: SHA } }), signer = async () => "https://fixture.invalid/private?signature=ephemeral") {
  const s3 = { send: jest.fn(send) }, sign = jest.fn(signer);
  const service = new ReplayFilesService({ client: s3, bucket: "mock-private-bucket", prefix: "private/v1", games, signer: sign });
  return { service, s3, sign };
}
const missing = () => Object.assign(new Error("private object key"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });

test("disposable Mongo enforces owner/LIVE/not-resumed while hidden and excluded originals remain individually eligible", async () => {
  const owned = await seed({ hidden: true, excluded: true });
  const foreign = await seed({ userId: "owner-b" }), deleted = await seed({ _deleted: true });
  const pending = await seed({ _deletionPending: true }), resumed = await seed({ isResumedFromReplay: true });
  const { service, s3, sign } = store();
  const ids = [foreign, owned, deleted, pending, resumed, "missing"];
  const result = await service.prepareDownloadBatch("owner-a", ids);
  expect(result).toMatchObject({ format: "sc2tools-replay-download-batch", version: 1,
    counts: { requested: 6, available: 1, unavailable: 5, retryable: 0 } });
  expect(result.items.map(row => row.gameId)).toEqual(ids);
  for (const index of [0, 2, 3, 4, 5]) expect(result.items[index]).toEqual({ gameId: ids[index], status: "unavailable", code: "replay_unavailable" });
  expect(result.items[1]).toMatchObject({ status: "available", sizeBytes: 8 });
  expect(s3.send).toHaveBeenCalledTimes(1); expect(sign).toHaveBeenCalledTimes(1);
  expect(s3.send.mock.calls[0][0].input.Key).toBe(`private/v1/owner-a/${owned}.SC2Replay`);
  expect(JSON.stringify(result)).not.toMatch(/mock-private-bucket|owner-b|uploadId|storedAt|md5|userId/);
});

const rotations = [
  ["uploadId", "replacementUploadId123456789"], ["version", 2], ["md5", OTHER_MD5],
  ["storedAt", STAMP.toISOString()], ["sizeBytes", new Double(8)],
];
test.each(rotations)("held mismatching HEAD cannot clear same-time/content marker rotated in %s", async (field, value) => {
  const gameId = await seed(), held = deferred(), entered = deferred();
  const { service } = store(async () => { entered.resolve(); return held.promise; });
  const work = service.prepareDownloadBatch("owner-a", [gameId]);
  try {
    await entered.promise;
    await games.updateOne({ gameId }, { $set: { [`replayFile.${field}`]: value } });
    held.resolve({ ContentLength: 9, Metadata: { sha256: SHA } });
    expect((await work).items[0]).toEqual({ gameId, status: "unavailable", code: "replay_unavailable" });
    const current = await games.findOne({ gameId });
    expect(current.replayFile).toBeDefined(); expect(current.replayFile.storedAt).toEqual(field === "storedAt" ? value : STAMP);
    expect(current.replayFile[field]).toEqual(value instanceof Double ? value.value : value);
  } finally { held.resolve({ ContentLength: 9, Metadata: { sha256: SHA } }); await work; }
});

test.each(rotations)("held signer cannot adopt same-time/content marker rotated in %s", async (field, value) => {
  const gameId = await seed(), held = deferred(), entered = deferred();
  const { service } = store(undefined, async () => { entered.resolve(); return held.promise; });
  const work = service.prepareDownloadBatch("owner-a", [gameId]);
  try {
    await entered.promise; await games.updateOne({ gameId }, { $set: { [`replayFile.${field}`]: value } });
    held.resolve("https://fixture.invalid/signed?signature=discard-me");
    const result = await work;
    expect(result.items[0]).toEqual({ gameId, status: "unavailable", code: "replay_unavailable" });
    expect(JSON.stringify(result)).not.toContain("discard-me");
    expect((await games.findOne({ gameId })).replayFile).toBeDefined();
  } finally { held.resolve("https://fixture.invalid/late"); await work; }
});

test.each(["HEAD", "signer"].flatMap(stage => [[stage, "uploadId", "newLegacyUploadId123456789"], [stage, "version", 1], [stage, "md5", MD5]]))(
  "legacy absence cannot become a present %s/%s marker while IO is held", async (stage, field, value) => {
  const old = { sizeBytes: 8, sha256: SHA, storedAt: STAMP };
  const gameId = await seed({ replayFile: old }), entered = deferred(), held = deferred();
  const { service } = stage === "HEAD" ? store(async () => { entered.resolve(); return held.promise; })
    : store(undefined, async () => { entered.resolve(); return held.promise; });
  const work = service.prepareDownloadBatch("owner-a", [gameId]);
  try {
    await entered.promise; await games.updateOne({ gameId }, { $set: { [`replayFile.${field}`]: value } });
    if (stage === "HEAD") held.reject(missing()); else held.resolve("https://fixture.invalid/private");
    expect((await work).items[0].status).toBe("unavailable");
    expect((await games.findOne({ gameId })).replayFile[field]).toBe(value);
  } finally { held.resolve("https://fixture.invalid/late"); await work; }
});

test.each([{ userId: "owner-b" }, { _deleted: true }, { _deletionPending: true }, { isResumedFromReplay: true }])(
  "last-observed owner/eligibility is rechecked after held signing: %j", async changed => {
    const gameId = await seed(), entered = deferred(), held = deferred();
    const { service } = store(undefined, async () => { entered.resolve(); return held.promise; });
    const work = service.prepareDownloadBatch("owner-a", [gameId]);
    try {
      await entered.promise; await games.updateOne({ gameId }, { $set: changed });
      held.resolve("https://fixture.invalid/private?signature=stale");
      expect((await work).items[0]).toEqual({ gameId, status: "unavailable", code: "replay_unavailable" });
      expect((await games.findOne({ gameId })).replayFile).toBeDefined();
    } finally { held.resolve("https://fixture.invalid/late"); await work; }
  });

test.each([
  { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }, { name: "AccessDenied", $metadata: { httpStatusCode: 404 } },
  { name: "TimeoutError" }, { code: "ECONNRESET" }, { $metadata: { httpStatusCode: 404 } }, { name: "NoSuchBucket", $metadata: { httpStatusCode: 404 } },
])("unknown storage failures are retryable and never clear the marker: %j", async fields => {
  const gameId = await seed(), clear = jest.spyOn(games, "updateOne");
  const { service, sign } = store(async () => { throw Object.assign(new Error("private-owner private-key signed-url"), fields); });
  const result = await service.prepareDownloadBatch("owner-a", [gameId]);
  expect(result.items[0]).toEqual({ gameId, status: "retryable", code: "replay_download_unavailable" });
  expect(clear).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
  expect((await games.findOne({ gameId })).replayFile).toEqual(marker());
  expect(JSON.stringify(result)).not.toMatch(/private-owner|private-key|signed-url/);
});

test.each(["missing", "length", "sha"])("a genuine %s clears only the still-matching marker", async mode => {
  const gameId = await seed();
  const { service } = store(async () => {
    if (mode === "missing") throw missing();
    return { ContentLength: mode === "length" ? 9 : 8, Metadata: { sha256: mode === "sha" ? "b".repeat(64) : SHA } };
  });
  const result = await service.prepareDownloadBatch("owner-a", [gameId]);
  expect(result.items[0].status).toBe("unavailable");
  expect(await games.findOne({ gameId, replayFile: { $exists: true } })).toBeNull();
});

test("four actual HEADs are the entire admission window and cancellation joins all held calls", async () => {
  const ids = await Promise.all(Array.from({ length: 9 }, () => seed())), gates = Array.from({ length: 4 }, deferred), entered = deferred();
  let active = 0, maximum = 0, calls = 0, settled = false;
  const { service, s3, sign } = store(async (_command, opts) => {
    expect(opts.abortSignal).toBe(controller.signal);
    const index = calls++; active++; maximum = Math.max(maximum, active);
    if (calls === 4) entered.resolve();
    try { return await gates[index].promise; } finally { active--; }
  });
  const controller = new AbortController();
  const work = service.prepareDownloadBatch("owner-a", ids, { signal: controller.signal });
  const observed = work.then(() => { settled = true; }, error => { settled = true; return error; });
  try {
    await entered.promise; expect(calls).toBe(4); expect(active).toBe(4);
    controller.abort(); await tick(); expect(settled).toBe(false);
    for (const gate of gates.slice(0, 3)) gate.resolve({ ContentLength: 8, Metadata: { sha256: SHA } });
    await tick(); expect(settled).toBe(false); expect(sign).not.toHaveBeenCalled();
    gates[3].resolve({ ContentLength: 8, Metadata: { sha256: SHA } });
    expect((await observed).name).toBe("AbortError");
    expect(maximum).toBe(4); expect(s3.send).toHaveBeenCalledTimes(4); expect(active).toBe(0);
  } finally { controller.abort(); for (const gate of gates) gate.resolve({ ContentLength: 8, Metadata: { sha256: SHA } }); await observed; }
});

test("a held non-cancellable signer cannot settle the batch early after abort", async () => {
  const gameId = await seed(), entered = deferred(), held = deferred(), controller = new AbortController();
  const { service } = store(undefined, async () => { entered.resolve(); return held.promise; });
  let settled = false;
  const work = service.prepareDownloadBatch("owner-a", [gameId], { signal: controller.signal }).then(() => { settled = true; }, error => { settled = true; return error; });
  try {
    await entered.promise; controller.abort(); await tick(); expect(settled).toBe(false);
    held.resolve("https://fixture.invalid/late"); expect((await work).name).toBe("AbortError");
  } finally { held.resolve("https://fixture.invalid/late"); await work; }
});

test("signing uses an explicit rounded60s lifetime and held expired URLs are discarded", async () => {
  const gameId = await seed(); let now = 1_800_000_000_987;
  const { service, sign } = store(undefined, async (_client, _command, options) => {
    expect(options).toEqual({ expiresIn: 60, signingDate: new Date(1_800_000_000_000) });
    now = 1_800_000_060_000; return "https://fixture.invalid/expired";
  });
  const result = await service.prepareDownloadBatch("owner-a", [gameId], { now: () => now });
  expect(sign).toHaveBeenCalledTimes(1);
  expect(result.items[0]).toEqual({ gameId, status: "retryable", code: "replay_download_expired" });
  expect(JSON.stringify(result)).not.toContain("fixture.invalid");
});

test("late slow slots expire earlier completed URLs again immediately before body publication", async () => {
  const ids = await Promise.all(Array.from({ length: 5 }, () => seed())); let now = 1_800_000_000_000;
  // Every earlier slot must take its issue time before the late slot moves the clock, whatever order the
  // four workers reach the signer in; otherwise a slow runner signs an earlier slot after the jump.
  const earlierSigned = deferred(); let earlier = 0;
  const { service } = store(undefined, async (_client, command) => {
    if (command.input.Key.endsWith(`${ids[4]}.SC2Replay`)) { await earlierSigned.promise; now += 60_000; }
    else if (++earlier === 4) earlierSigned.resolve();
    return "https://fixture.invalid/private";
  });
  const result = await service.prepareDownloadBatch("owner-a", ids, { now: () => now });
  expect(result.items.every(row => row.status === "retryable" && row.code === "replay_download_expired")).toBe(true);
  expect(result.counts).toEqual({ requested: 5, available: 0, unavailable: 0, retryable: 5 });
});

test("all initial/final reads and stale CAS carry one constant private log comment", async () => {
  const gameId = await seed(), read = jest.spyOn(games, "findOne"), update = jest.spyOn(games, "updateOne");
  await store().service.prepareDownloadBatch("owner-a", [gameId]);
  expect(read.mock.calls).toHaveLength(2);
  for (const [, options] of read.mock.calls) expect(options).toMatchObject({ maxTimeMS: 5000, comment: REPLAY_DOWNLOAD_COMMENT, signal: expect.any(AbortSignal) });
  await store(async () => { throw missing(); }).service.prepareDownloadBatch("owner-a", [gameId]);
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0][2]).toEqual({ maxTimeMS: 5000, comment: REPLAY_DOWNLOAD_COMMENT });
});

test("four-worker service boundary admits exactly four held HEADs before cancellation", async () => {
  const gates = Array.from({ length: 9 }, deferred), entered = deferred(), controller = new AbortController();
  const fakeGames = { findOne: jest.fn(async filter => ({ gameId: filter.gameId, replayFile: marker(),
    __packType_version: "int", __packType_uploadId: "string", __packType_sizeBytes: "int", __packType_sha256: "string", __packType_md5: "string", __packType_storedAt: "date" })) };
  let heads = 0, settled = false;
  const s3 = { send: jest.fn(() => { const gate = gates[heads++]; if (heads === 4) entered.resolve(); return gate.promise; }) };
  const service = new ReplayFilesService({ client: s3, bucket: "mock-bucket", games: fakeGames, signer: jest.fn() });
  const work = service.prepareDownloadBatch("owner-a", Array.from({ length: 9 }, (_, index) => `bounded-${index}`), { signal: controller.signal });
  const observed = work.then(() => { settled = true; }, error => { settled = true; return error; });
  try {
    await entered.promise; await tick();
    expect(heads).toBe(4); expect(fakeGames.findOne).toHaveBeenCalledTimes(4);
    controller.abort(); await tick(); expect(settled).toBe(false);
  } finally {
    controller.abort(); for (const gate of gates) gate.resolve({ ContentLength: 8, Metadata: { sha256: SHA } });
    expect((await observed).name).toBe("AbortError");
  }
  expect(s3.send).toHaveBeenCalledTimes(4);
});

test("cancelled batch awaits actual non-cancellable stale-marker CAS", async () => {
  const entered = deferred(), held = deferred(), controller = new AbortController();
  const fakeGames = { findOne: jest.fn(async () => ({ replayFile: marker(), __packType_version: "int", __packType_uploadId: "string",
    __packType_sizeBytes: "int", __packType_sha256: "string", __packType_md5: "string", __packType_storedAt: "date" })),
    updateOne: jest.fn(async () => { entered.resolve(); return held.promise; }) };
  const service = new ReplayFilesService({ client: { send: async () => ({ ContentLength: 9, Metadata: { sha256: SHA } }) }, bucket: "mock-bucket", games: fakeGames, signer: jest.fn() });
  let settled = false;
  const work = service.prepareDownloadBatch("owner-a", ["held-cas"], { signal: controller.signal });
  const observed = work.then(() => { settled = true; }, error => { settled = true; return error; });
  try {
    await entered.promise; controller.abort(); await tick(); expect(settled).toBe(false);
    expect(fakeGames.updateOne.mock.calls[0][2]).toEqual({ maxTimeMS: 5000, comment: REPLAY_DOWNLOAD_COMMENT });
    held.resolve({ matchedCount: 1 }); expect((await observed).name).toBe("AbortError");
  } finally { controller.abort(); held.resolve({ matchedCount: 1 }); await observed; }
});

test("present optional marker fields cannot disappear under a held stale HEAD", async () => {
  const gameId = await seed(), held = deferred(), entered = deferred();
  const { service } = store(async () => { entered.resolve(); return held.promise; });
  const work = service.prepareDownloadBatch("owner-a", [gameId]);
  try {
    await entered.promise; await games.updateOne({ gameId }, { $unset: { "replayFile.version": "" } });
    held.reject(missing()); expect((await work).items[0].status).toBe("unavailable");
    const current = await games.findOne({ gameId }); expect(current.replayFile).toBeDefined(); expect(current.replayFile.version).toBeUndefined();
  } finally { held.resolve({ ContentLength: 9, Metadata: { sha256: SHA } }); await work; }
});

test("malformed markers fail closed before HEAD and malformed HEAD responses remain unknown without cleanup", async () => {
  const { service, s3 } = store();
  for (const extra of [{ sizeBytes: 3 }, { sizeBytes: 5 * 1024 * 1024 + 1 }, { sizeBytes: [8] }, { sha256: SHA.toUpperCase() },
    { storedAt: null }, { storedAt: "not-a-date" }, { version: null }, { uploadId: null }, { md5: null }]) {
    const gameId = await seed({ replayFile: marker(extra) });
    expect((await service.prepareDownloadBatch("owner-a", [gameId])).items[0].status).toBe("unavailable");
  }
  expect(s3.send).not.toHaveBeenCalled();
  const gameId = await seed(), clear = jest.spyOn(games, "updateOne");
  const result = await store(async () => ({ Metadata: { sha256: SHA } })).service.prepareDownloadBatch("owner-a", [gameId]);
  expect(result.items[0].status).toBe("retryable"); expect(clear).not.toHaveBeenCalled();
});

test("unsafe or over-budget signed output becomes a fixed retryable row without clearing the marker", async () => {
  const gameId = await seed(), clear = jest.spyOn(games, "updateOne");
  for (const url of ["https://fixture.invalid/" + "x".repeat(4096), "javascript:private-secret", "https://fixture.invalid/" + "\u3042".repeat(3000)]) {
    const result = await store(undefined, async () => url).service.prepareDownloadBatch("owner-a", [gameId]);
    expect(result.items[0]).toEqual({ gameId, status: "retryable", code: "replay_download_unavailable" });
    expect(JSON.stringify(result)).not.toContain("fixture.invalid");
  }
  expect(clear).not.toHaveBeenCalled();
});

test("the existing individual download keeps its exact shape and configured lifetime", async () => {
  const gameId = await seed({ isResumedFromReplay: true }), { service, sign } = store(); service.downloadExpiresSec = 17;
  const result = await service.prepareDownload("owner-a", gameId);
  expect(Object.keys(result).sort()).toEqual(["expiresIn", "filename", "url"]); expect(result.expiresIn).toBe(17);
  expect(sign.mock.calls[0][2]).toEqual({ expiresIn: 17 });
  expect((await service.prepareDownloadBatch("owner-a", [gameId])).items[0].status).toBe("unavailable");
});

test.each([null, [], "not-a-map", 1, { sha256: null }, { sha256: [] }, { sha256: 1 }, new Date()])(
  "malformed SDK metadata is unknown and never clears the captured marker: %p", async metadata => {
    const gameId = await seed(), clear = jest.spyOn(games, "updateOne");
    const result = await store(async () => ({ ContentLength: 8, Metadata: metadata })).service.prepareDownloadBatch("owner-a", [gameId]);
    expect(result.items[0]).toEqual({ gameId, status: "retryable", code: "replay_download_unavailable" });
    expect(clear).not.toHaveBeenCalled(); expect((await games.findOne({ gameId })).replayFile).toEqual(marker());
  });

test.each([undefined, {}, { sha256: "wrong-string-sha" }])("valid absent/mismatching metadata permits exact stale CAS: %p", async metadata => {
  const gameId = await seed();
  const result = await store(async () => ({ ContentLength: 8, Metadata: metadata })).service.prepareDownloadBatch("owner-a", [gameId]);
  expect(result.items[0]).toEqual({ gameId, status: "unavailable", code: "replay_unavailable" });
  expect((await games.findOne({ gameId })).replayFile).toBeUndefined();
});
