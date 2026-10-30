// @ts-nocheck
"use strict";
const { ObjectId } = require("mongodb");
const { randomUUID: uuid } = require("crypto");
const { OpponentsService } = require("../src/services/opponents");
const { MAX_ACTIVE } = require("../src/services/gameStatsWrites");
const { immutableNeutralMutation } = require("../src/services/gameStatsCountNeutral");
const { takeRepairLivenessIssuer } = require("../src/services/gdprRepairLiveness");
const { snapshotStampGame, regionStampPossible, gameStampAdmission, backfillStampAdmission, stampOpponentGameRegion,
  healOpponentGameIdentity } = require("../src/services/opponentGameStamps");

const userId = "stamp-owner", TOON = "2-S2-1-5", PLAYED = new Date("2026-10-01T00:00:00Z"), T0 = Date.parse("2026-10-30T12:00:00Z");
const FIELDS = ["pulseId", "gameId", "toonHandle", "pulseCharacterId", "pulseLookupAttempted", "displayName", "race", "mmr",
  "leagueId", "result", "opening", "region", "playedAt"];
const game = extra => ({ pulseId: "p1", gameId: "g1", toonHandle: TOON, displayName: "Name", race: "P", result: "Victory",
  playedAt: new Date(PLAYED), ...extra });
const ROWS = [{ pulseId: "p1", toonHandle: TOON, displayNameSample: "a" }, { pulseId: "p2", toonHandle: TOON }, { pulseId: "p3", toonHandle: TOON }];
let issuer;
beforeAll(() => { issuer = takeRepairLivenessIssuer(); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
function held() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function harness({ rows = ROWS, prior = { pulseId: "p1", toonHandle: TOON, displayNameSample: "Name" } } = {}) {
  const events = [], ownerId = new ObjectId(), result = { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  const log = (name, value) => async () => { events.push(name); return typeof value === "function" ? value() : value; };
  const users = { findOne: jest.fn(log("users.findOne", () => ({ _id: ownerId }))), updateOne: jest.fn(log("users.updateOne", { acknowledged: true, matchedCount: 1 })) };
  const opponents = { findOne: jest.fn(log("opponents.findOne", () => prior && { ...prior })),
    updateOne: jest.fn(log("opponents.updateOne", { matchedCount: 1, modifiedCount: 1 })),
    find: jest.fn(() => ({ limit: () => ({ toArray: log("opponents.find", () => rows.map(row => ({ ...row }))) }) })) };
  const games = { findOne: jest.fn(log("games.findOne", null)), updateOne: jest.fn(log("games.updateOne", result)),
    updateMany: jest.fn(log("games.updateMany", result)) };
  const provider = jest.fn(log("provider", { mmr: 4100, region: "EU" }));
  const pulseResolver = { resolve: jest.fn(log("resolver", "777")) };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const revisions = { run: jest.fn(async (_owner, work) => work()) };
  const db = { users, opponents, opponentNotes: {}, games };
  const service = new OpponentsService(db, Buffer.alloc(32, 1), { logger, pulseResolver, userRevision: revisions,
    pulseMmr: { getCurrentMmr: provider, getCurrentMmrByToon: provider } });
  return { events, ownerId, users, opponents, games, provider, pulseResolver, logger, revisions, service, writer: service.gameStatsWrites };
}
function repairContext(id = new ObjectId(), kind = "repair_opponents") {
  const fenceId = uuid(), captured = { userId, id, epoch: undefined, compatibility: true }, owner = { ...captured, epoch: fenceId };
  return { fenceId, kind, owner, context: { owner, fenceId, kind, handle: issuer.issue(captured, fenceId, kind) } };
}
function holdCapture(h) {
  const entered = held(), gate = held();
  h.users.findOne.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return { _id: h.ownerId }; });
  return { entered: entered.promise, release: gate.resolve };
}
function traceCapture(h) {
  const original = h.writer.capture.bind(h.writer);
  return jest.spyOn(h.writer, "capture").mockImplementation(async id => {
    h.events.push("capture:start");
    try { return await original(id); } finally { h.events.push("capture:settled"); }
  });
}
const PRODUCERS = {
  recordGame: (h, options) => h.service.recordGame(userId, game(), options),
  refreshMetadata: (h, options) => h.service.refreshMetadata(userId, game(), options),
  retryPulseResolution: (h, options) => h.service.retryPulseResolution(userId, "p1", options),
  backfillPulseCharacterId: (h, options) => h.service.backfillPulseCharacterId(userId, { limit: 5, ...options }),
};
const warnings = h => h.logger.warn.mock.calls.map(call => call[1]);
const dated = calls => JSON.parse(JSON.stringify(calls, function replace(key, value) { return this[key] instanceof Date ? "<date>" : value; }));

test("the snapshot copies exactly the consumed fields and clones only a Date playedAt", () => {
  const input = { ...game({ pulseCharacterId: "7", pulseLookupAttempted: true, mmr: 4000, leagueId: 4, opening: "o", region: "EU" }), extra: "x" };
  const snap = snapshotStampGame(input), original = input.playedAt;
  expect(Object.isFrozen(snap)).toBe(true); expect(Object.keys(snap).sort()).toEqual([...FIELDS].sort());
  expect(snap.playedAt).not.toBe(original); expect(snap.playedAt.getTime()).toBe(PLAYED.getTime());
  input.pulseId = "changed"; input.region = "NA"; original.setTime(0);
  expect(snap).toMatchObject({ pulseId: "p1", region: "EU" }); expect(snap.playedAt.getTime()).toBe(PLAYED.getTime());
  const invalid = snapshotStampGame(game({ playedAt: new Date(NaN) })).playedAt;
  expect(invalid).toBeInstanceOf(Date); expect(Number.isNaN(invalid.getTime())).toBe(true);
  const marker = { at: 1 };
  for (const playedAt of ["2026-10-01", 7, marker, undefined]) expect(snapshotStampGame(game({ playedAt })).playedAt).toBe(playedAt);
  expect(regionStampPossible(snap)).toBe(false); expect(regionStampPossible(snapshotStampGame(game()))).toBe(true);
  for (const extra of [{ gameId: undefined }, { gameId: "" }, { gameId: 7 }, { region: "" }]) expect(regionStampPossible(game(extra))).toBe(false);
});

test("omission performs one capture with immediate handlers and yields a frozen owner copy", async () => {
  const id = new ObjectId(), capture = jest.fn(async () => ({ userId, id, epoch: undefined, compatibility: true }));
  const admission = await gameStampAdmission({ capture }, userId, undefined, true);
  expect(capture.mock.calls).toEqual([[userId]]); expect(admission.ok).toBe(true);
  expect(Object.isFrozen(admission)).toBe(true); expect(Object.isFrozen(admission.owner)).toBe(true);
  expect(admission.owner).toEqual({ userId, id, compatibility: true }); expect(String(admission.owner.id)).toBe(String(id));
  const failure = new Error("capture failed"), unhandled = jest.fn(); process.on("unhandledRejection", unhandled);
  try {
    expect(await gameStampAdmission({ capture: () => Promise.reject(failure) }, userId, undefined, true)).toEqual({ ok: false, error: failure });
    expect(await gameStampAdmission({ capture: () => { throw failure; } }, userId, undefined, true)).toEqual({ ok: false, error: failure });
    await new Promise(resolve => setImmediate(resolve)); expect(unhandled).not.toHaveBeenCalled();
  } finally { process.off("unhandledRejection", unhandled); }
  for (const owner of [{ userId: "foreign", id, compatibility: true }, { userId, id, compatibility: "yes" }, { userId, compatibility: true },
    null, { userId, id, compatibility: true, extra: 1 }]) {
    expect((await gameStampAdmission({ capture: async () => owner }, userId, undefined, true)).ok).toBe(false);
  }
});

test("invalid supplied owners and non-plain options are unavailable with zero captures", async () => {
  const capture = jest.fn(), owner = { userId, id: new ObjectId(), compatibility: true }, getter = jest.fn(() => owner);
  const accessor = {}; Object.defineProperty(accessor, "statsOwner", { enumerable: true, get: getter });
  class Options { constructor() { this.statsOwner = owner; } }
  const cases = [{ statsOwner: undefined }, { statsOwner: null }, { statsOwner: { userId } }, { statsOwner: { ...owner, userId: "foreign" } },
    { statsOwner: { ...owner, [Symbol("x")]: 1 } }, accessor, Object.assign(Object.create(null), { statsOwner: owner }), null, new Options(), [], "options"];
  for (const options of cases) expect((await gameStampAdmission({ capture }, userId, options, true)).ok).toBe(false);
  const ready = await gameStampAdmission({ capture }, userId, { statsOwner: owner, limit: 3 }, true);
  expect(ready).toMatchObject({ ok: true, owner: { userId, compatibility: true } }); expect(ready.owner).not.toBe(owner);
  expect((await gameStampAdmission({ capture }, userId, accessor, false)).ok).toBe(false);
  expect((await gameStampAdmission({ capture }, userId, undefined, false)).ok).toBe(false);
  expect(capture).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
});

test("a repair context is ready only through the backfill entry, when genuine and live, and never captures", async () => {
  const capture = jest.fn(), r = repairContext();
  const ready = await backfillStampAdmission({ capture }, userId, { limit: 5, force: true, repair: r.context });
  expect(ready.ok).toBe(true); expect(Object.isFrozen(ready.repair)).toBe(true); expect(ready.repair.handle).toBe(r.context.handle);
  expect(ready.repair).toMatchObject({ fenceId: r.fenceId, kind: r.kind }); expect(ready.repair.owner).not.toBe(r.owner);
  const bad = [undefined, null, { ...r.context, handle: Object.freeze(Object.create(null)) }, JSON.parse(JSON.stringify(r.context)),
    { ...r.context, owner: { ...r.owner, userId: "foreign" } }, { ...r.context, owner: { ...r.owner, id: null } },
    { ...r.context, fenceId: uuid() }, { ...r.context, kind: "restore" }, { ...r.context, extra: 1 }];
  for (const repair of bad) expect((await backfillStampAdmission({ capture }, userId, { force: true, repair })).ok).toBe(false);
  const accessor = {}; Object.defineProperty(accessor, "repair", { enumerable: true, get: () => r.context });
  expect((await backfillStampAdmission({ capture }, userId, accessor)).ok).toBe(false);
  const closed = repairContext(); issuer.release(closed.context.handle);
  expect((await backfillStampAdmission({ capture }, userId, { repair: closed.context })).error.cause).toMatchObject({ code: "gdpr_repair_fence_released" });
  expect((await backfillStampAdmission({ capture }, userId, { repair: r.context, statsOwner: r.owner })).ok).toBe(false);
  for (const options of [{ repair: r.context }, { repair: undefined }, { statsOwner: r.owner, repair: r.context }]) {
    const refused = await gameStampAdmission({ capture }, userId, options, true);
    expect(refused).toMatchObject({ ok: false, error: { code: "opponent_game_stamp_options_invalid" } });
  }
  expect(capture).not.toHaveBeenCalled();
});

test.each(["recordGame", "refreshMetadata"])("a %s call that cannot stamp performs zero captures and keeps its opponent work", async method => {
  const expected = await harness().service[method](userId, game());
  for (const extra of [{ gameId: undefined }, { gameId: "" }, { gameId: 7 }, { region: "NA" }, { region: "" }]) {
    const h = harness(), capture = jest.spyOn(h.writer, "capture"), write = jest.spyOn(h.writer, "write");
    expect(await h.service[method](userId, game(extra))).toEqual(expected);
    expect(capture).not.toHaveBeenCalled(); expect(h.users.findOne).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    expect(h.games.updateOne).not.toHaveBeenCalled(); expect(h.users.updateOne).not.toHaveBeenCalled();
    expect(h.opponents.updateOne).toHaveBeenCalledTimes(1); expect(h.logger.warn).not.toHaveBeenCalled();
  }
});

test.each([["floor unavailable", "game_stats_read_floor_unavailable"], ["transaction timeout", "MongoOperationTimeoutError"]])("a %s rejection maps to the existing warning while the opponent work lands", async (_name, code) => {
  const failure = Object.assign(new Error(code), { code });
  for (const method of ["recordGame", "backfillPulseCharacterId"]) {
    const h = harness(), write = jest.spyOn(h.writer, "write").mockRejectedValue(failure);
    const result = method === "recordGame" ? await h.service.recordGame(userId, game()) : await h.service.backfillPulseCharacterId(userId, { limit: 5 });
    expect(result).toEqual(method === "recordGame" ? { upgraded: false, from: null, to: null, mmr: 4100, region: "EU" } : { scanned: 3, resolved: 3, updated: 3, skipped: 0 });
    expect(write).toHaveBeenCalledTimes(method === "recordGame" ? 1 : 3); expect(h.opponents.updateOne).toHaveBeenCalledTimes(method === "recordGame" ? 1 : 3);
    expect(h.logger.warn.mock.calls.map(call => call[0].err)).toEqual(Array(method === "recordGame" ? 1 : 3).fill(failure));
  }
});

test("unavailable or missing admissions and invalid descriptors throw before any UserRevision work", async () => {
  const writer = { write: jest.fn() }, revisions = { run: jest.fn() }, error = new Error("veto"), unavailable = { ok: false, error };
  await expect(stampOpponentGameRegion(writer, revisions, userId, "g1", "EU", unavailable)).rejects.toBe(error);
  await expect(healOpponentGameIdentity(writer, revisions, userId, "p1", { region: "EU" }, unavailable)).rejects.toBe(error);
  for (const call of [() => stampOpponentGameRegion(writer, revisions, userId, "g1", "EU"), () => healOpponentGameIdentity(writer, revisions, userId, "p1", { region: "EU" })]) {
    await expect(call()).rejects.toMatchObject({ code: "opponent_game_stamp_admission_required" });
  }
  const r = repairContext(), repair = await backfillStampAdmission({ capture: jest.fn() }, userId, { repair: r.context });
  await expect(stampOpponentGameRegion(writer, revisions, userId, "g1", "EU", repair)).rejects.toMatchObject({ code: "opponent_game_region_repair_rejected" });
  const owner = await gameStampAdmission({ capture: jest.fn() }, userId, { statsOwner: { userId, id: new ObjectId(), compatibility: true } }, true);
  for (const pulseId of [7, null, undefined, { $ne: null }]) {
    await expect(healOpponentGameIdentity(writer, revisions, userId, pulseId, { region: "EU" }, owner)).rejects.toMatchObject({ code: "game_stats_neutral_operation_invalid" });
  }
  await expect(stampOpponentGameRegion(writer, revisions, userId, "", "EU", owner)).rejects.toMatchObject({ code: "game_stats_neutral_operation_invalid" });
  expect(revisions.run).not.toHaveBeenCalled(); expect(writer.write).not.toHaveBeenCalled();
});

test("ordinary admissions write the branded descriptor; repair admissions use only the repair capability", async () => {
  const h = harness(), write = jest.spyOn(h.writer, "write"), admission = await gameStampAdmission(h.writer, userId, undefined, true);
  await stampOpponentGameRegion(h.writer, h.revisions, userId, "g1", "EU", admission);
  await healOpponentGameIdentity(h.writer, h.revisions, userId, "p1", { pulseCharacterId: "9" }, admission);
  const [[regionOwner, regionDescriptor], [, identityDescriptor]] = write.mock.calls;
  expect(regionOwner).toBe(admission.owner); expect(Object.isFrozen(regionDescriptor)).toBe(true);
  expect(regionDescriptor).toEqual({ kind: "opponentGameRegion", gameId: "g1", region: "EU" });
  expect(immutableNeutralMutation(regionDescriptor)).toBe(regionDescriptor);
  expect(identityDescriptor).toEqual({ kind: "opponentGameIdentity", pulseId: "p1", pulseCharacterId: "9" });
  expect(h.revisions.run).toHaveBeenCalledTimes(2);
  const r = repairContext(h.ownerId), repair = await backfillStampAdmission(h.writer, userId, { repair: r.context });
  write.mockClear(); h.users.updateOne.mockClear();
  await healOpponentGameIdentity(h.writer, h.revisions, userId, "p1", { region: "EU" }, repair);
  expect(write).not.toHaveBeenCalled();
  expect(h.users.updateOne.mock.calls[0][0]).toMatchObject({ "_gdprMutation.id": r.fenceId, "_gdprMutation.kind": "repair_opponents" });
  expect(h.games.updateMany).toHaveBeenLastCalledWith({ userId, "opponent.pulseId": "p1" }, { $set: { "opponent.region": "EU" } }, { upsert: false });
});

test("helper no-ops return before admission is used, and helpers never capture", async () => {
  const h = harness(), write = jest.spyOn(h.writer, "write"), capture = jest.spyOn(h.writer, "capture");
  const poison = new Proxy({}, { get: () => { throw new Error("admission used"); } });
  for (const [gameId, incoming, set] of [[undefined, {}, { region: "EU" }], ["", {}, { region: "EU" }], [7, {}, { region: "EU" }],
    ["g1", { region: "NA" }, { region: "EU" }], ["g1", { region: "" }, { region: "EU" }], ["g1", {}, { region: 7 }], ["g1", {}, {}]]) {
    expect(await h.service._stampGameRegion(userId, gameId, incoming, set, poison)).toBeUndefined();
  }
  for (const set of [{}, { region: 7, pulseCharacterId: null }, { mmr: 4000 }]) expect(await h.service._backfillGameIdentity(userId, "p1", set, poison)).toBe(0);
  expect(h.logger.warn).not.toHaveBeenCalled(); expect(h.revisions.run).not.toHaveBeenCalled();
  expect(await h.service._stampGameRegion(userId, "g1", {}, { region: "EU" })).toBeUndefined();
  expect(await h.service._backfillGameIdentity(userId, "p1", { region: "EU" })).toBe(0);
  expect(write).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled(); expect(h.revisions.run).not.toHaveBeenCalled();
  expect(h.users.findOne).not.toHaveBeenCalled(); expect(h.users.updateOne).not.toHaveBeenCalled();
  expect(h.logger.warn.mock.calls).toEqual([
    [{ err: expect.objectContaining({ code: "opponent_game_stamp_admission_required" }), userId, gameId: "g1" }, "opponent_game_region_stamp_failed"],
    [{ err: expect.objectContaining({ code: "opponent_game_stamp_admission_required" }), userId, pulseId: "p1" }, "opponent_pulse_backfill_game_identity_failed"]]);
});

test.each(Object.keys(PRODUCERS))("%s settles its single capture before the first opponents, games or provider IO", async method => {
  const h = harness(), capture = traceCapture(h);
  await PRODUCERS[method](h);
  const settled = h.events.indexOf("capture:settled"), firstIo = h.events.findIndex(event => /^(opponents|games)\.|provider|resolver/.test(event));
  expect(capture).toHaveBeenCalledTimes(1); expect(settled).toBeGreaterThan(-1); expect(settled).toBeLessThan(firstIo);
  expect(h.events.filter(event => /^games\.update/.test(event)).length).toBeGreaterThan(0);
  const supplied = harness(), suppliedCapture = traceCapture(supplied);
  await PRODUCERS[method](supplied, { statsOwner: { userId, id: supplied.ownerId, compatibility: true } });
  expect(suppliedCapture).not.toHaveBeenCalled(); expect(supplied.users.findOne).not.toHaveBeenCalled();
  expect(supplied.events.filter(event => /^games\.update/.test(event)).length).toBeGreaterThan(0);
});

test("a failed capture changes only the attempted stamp's outcome", async () => {
  const ok = harness(), failed = harness(), failure = new Error("capture down");
  jest.spyOn(failed.writer, "capture").mockRejectedValue(failure);
  const expected = await ok.service.recordGame(userId, game());
  expect(await failed.service.recordGame(userId, game())).toEqual(expected);
  expect(dated(failed.opponents.updateOne.mock.calls)).toEqual(dated(ok.opponents.updateOne.mock.calls));
  expect(failed.provider.mock.calls).toEqual(ok.provider.mock.calls); expect(failed.logger.info.mock.calls).toEqual(ok.logger.info.mock.calls);
  expect(ok.games.updateOne).toHaveBeenCalledTimes(1); expect(failed.games.updateOne).not.toHaveBeenCalled();
  expect(ok.logger.warn).not.toHaveBeenCalled();
  expect(failed.logger.warn.mock.calls).toEqual([[{ err: failure, userId, gameId: "g1" }, "opponent_game_region_stamp_failed"]]);
});

test("backfill keeps its call-time cutoff and retry its post-read timestamp while capture is held", async () => {
  jest.useFakeTimers({ now: T0, doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setTimeout", "clearTimeout", "setInterval",
    "clearInterval", "queueMicrotask", "hrtime", "performance"] });
  const h = harness({ rows: [] }), hold = holdCapture(h);
  const task = h.service.backfillPulseCharacterId(userId, { limit: 5, maxAgeSec: 60 }); await hold.entered;
  jest.setSystemTime(T0 + 3_600_000); hold.release(); await task;
  expect(h.opponents.find.mock.calls[0][0].$and[0].$or[2]).toEqual({ pulseResolveAttemptedAt: { $lt: new Date(T0 - 60_000) } });
  jest.setSystemTime(T0);
  const r = harness(), retryHold = holdCapture(r);
  r.opponents.findOne.mockImplementationOnce(async () => { jest.setSystemTime(T0 + 20_000); return { pulseId: "p1", toonHandle: TOON }; });
  const retry = r.service.retryPulseResolution(userId, "p1"); await retryHold.entered;
  jest.setSystemTime(T0 + 10_000); retryHold.release(); await retry;
  expect(r.opponents.updateOne.mock.calls[0][1].$set.pulseResolveAttemptedAt).toEqual(new Date(T0 + 20_000));
});

test("mutating producer inputs, options or owners after admission changes no filter, firstSeen or authority", async () => {
  const h = harness({ prior: null }), hold = holdCapture(h), input = game();
  const task = h.service.recordGame(userId, input); await hold.entered;
  Object.assign(input, { pulseId: "other", gameId: "other", toonHandle: "1-S2-1-9", result: "Defeat" }); input.playedAt.setTime(0);
  hold.release(); await task;
  expect(h.opponents.findOne.mock.calls[0][0]).toEqual({ userId, pulseId: "p1" });
  const [filter, update] = h.opponents.updateOne.mock.calls[0];
  expect(filter).toEqual({ userId, pulseId: "p1" }); expect(update.$min.firstSeen.getTime()).toBe(PLAYED.getTime()); expect(update.$inc.wins).toBe(1);
  expect(h.games.updateOne.mock.calls[0][0]).toEqual({ userId, gameId: "g1" });
  expect(String(h.users.updateOne.mock.calls[0][0]._id)).toBe(String(h.ownerId));
  const s = harness({ prior: null }), id = new ObjectId(), statsOwner = { userId, id, compatibility: true }, options = { statsOwner };
  const supplied = s.service.refreshMetadata(userId, game(), options);
  options.statsOwner = { ...statsOwner, userId: "other" }; statsOwner.id = new ObjectId(); statsOwner.userId = "other";
  await supplied;
  expect(String(s.users.updateOne.mock.calls[0][0]._id)).toBe(String(id)); expect(s.users.findOne).not.toHaveBeenCalled();
});

test("a busy or stopped writer refuses only the game writes while every backfill row still resolves", async () => {
  const baseline = await harness().service.backfillPulseCharacterId(userId, { limit: 5 });
  const busy = harness(), capture = jest.spyOn(busy.writer, "capture"), write = jest.spyOn(busy.writer, "write");
  for (let i = 0; i < MAX_ACTIVE; i += 1) busy.writer.pending.add(new Promise(() => {}));
  expect(await busy.service.backfillPulseCharacterId(userId, { limit: 5 })).toEqual(baseline);
  expect(capture).toHaveBeenCalledTimes(1); await expect(capture.mock.results[0].value).resolves.toMatchObject({ userId });
  expect(write).toHaveBeenCalledTimes(3);
  for (const call of write.mock.results) await expect(call.value).rejects.toMatchObject({ code: "game_stats_writer_busy" });
  expect(busy.writer.pending.size).toBe(MAX_ACTIVE); expect(busy.games.updateMany).not.toHaveBeenCalled();
  expect(warnings(busy)).toEqual(Array(3).fill("opponent_pulse_backfill_game_identity_failed"));
  const stopped = harness(); await stopped.writer.stopAndDrain(); const stoppedCapture = jest.spyOn(stopped.writer, "capture");
  expect(await stopped.service.backfillPulseCharacterId(userId, { limit: 5 })).toEqual(baseline);
  expect(stoppedCapture).toHaveBeenCalledTimes(1);
  await expect(stoppedCapture.mock.results[0].value).rejects.toMatchObject({ code: "game_stats_writer_stopping" });
  expect(stopped.logger.warn.mock.calls.map(call => call[0].err.code)).toEqual(Array(3).fill("game_stats_writer_stopping"));
  expect(stopped.games.updateMany).not.toHaveBeenCalled();
});

test("a legacy numeric opponents pulseId has its heal vetoed with the warning", async () => {
  const h = harness({ rows: [{ pulseId: 12345, toonHandle: TOON }] });
  expect(await h.service.backfillPulseCharacterId(userId, { limit: 5 })).toEqual({ scanned: 1, resolved: 1, updated: 1, skipped: 0 });
  expect(h.games.updateMany).not.toHaveBeenCalled(); expect(h.revisions.run).not.toHaveBeenCalled();
  expect(h.logger.warn.mock.calls).toEqual([[{ err: expect.objectContaining({ code: "game_stats_neutral_operation_invalid" }), userId, pulseId: 12345 },
    "opponent_pulse_backfill_game_identity_failed"]]);
});
