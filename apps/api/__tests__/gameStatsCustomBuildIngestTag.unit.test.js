// @ts-nocheck
"use strict";
const { ObjectId, Timestamp } = require("mongodb");
const { randomUUID: uuid } = require("crypto");
jest.mock("../src/services/gameStatsReadFloor", () => ({ statsReadFloorFor: jest.fn() }));
const { statsReadFloorFor } = require("../src/services/gameStatsReadFloor");
const { GameStatsWrites } = require("../src/services/gameStatsWrites");
const { CustomBuildsService } = require("../src/services/customBuilds");
const { immutableCustomBuildIngestTag } = require("../src/services/gameStatsCustomBuildIngestTag");
const { tagClassificationPipeline } = require("../src/services/buildIntentGuards");
const { stamped, original } = require("./helpers/corpusStamp");
const userId = "ingest-tag-owner";
const decision = extra => ({ you: { mode: "set", name: "$Saved", slug: "saved" }, opponent: { mode: "keep" },
  payloadBuild: "Agent", payloadStrategy: "Enemy", policyBuild: null, policyStrategy: null, clearStaging: true, ...extra });
const mutation = extra => ({ kind: "customBuildIngestTag", gameId: "one", expectedRevision: "revision-one", decision: decision(), ...extra });
const game = () => ({ gameId: "one", myRace: "Protoss", myBuild: "Agent", opponent: { race: "Zerg", strategy: "Enemy" },
  buildLog: [], oppBuildLog: [], spatial: undefined });
function held() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function harness() {
  const owner = { userId, id: new ObjectId(), epoch: uuid(), compatibility: false }, events = [];
  const session = { advanceOperationTime: jest.fn(), withTransaction: jest.fn(async fn => fn()), endSession: jest.fn(async () => {}) };
  const users = { findOne: jest.fn(async () => ({ _id: owner.id, gameStatsMutationEpoch: owner.epoch })),
    findOneAndUpdate: jest.fn(async () => { events.push("owner"); return {}; }), updateOne: jest.fn(async () => ({ matchedCount: 1 })) };
  const games = { findOneAndUpdate: jest.fn(async () => { events.push("game"); return { _id: "one" }; }) };
  const db = { users, games, customBuilds: {}, customBuildJobs: {}, gameStatsTransactions: true, client: { startSession: jest.fn(() => session) } };
  const writer = new GameStatsWrites(db), custom = new CustomBuildsService(db, { perGame: { catalog: null } });
  custom.gameStatsWrites = writer;
  custom._iterateForClassification = jest.fn(async function* () { yield []; });
  return { db, owner, session, users, games, writer, custom, events };
}
beforeEach(() => { statsReadFloorFor.mockReset(); statsReadFloorFor.mockReturnValue(() => new Timestamp({ t: 12, i: 1 })); });
afterEach(() => jest.restoreAllMocks());

test.each(["filter", "pipeline", "update", "upsert", "userId", "session", "repairFenceId", "countNeutral"])("rejects arbitrary %s before any writer work", async key => {
  const h = harness(); await expect(h.writer.write(h.owner, mutation({ [key]: true }))).rejects.toThrow("game_stats_neutral_operation_invalid");
  expect(statsReadFloorFor).not.toHaveBeenCalled(); expect(h.db.client.startSession).not.toHaveBeenCalled();
  expect(h.users.findOneAndUpdate).not.toHaveBeenCalled(); expect(h.games.findOneAndUpdate).not.toHaveBeenCalled();
});
const invalidMutations = [
  { gameId: ["one"] }, { expectedRevision: undefined }, { expectedRevision: 1 },
  { decision: decision({ clearStaging: "true" }) }, { decision: decision({ you: { mode: "set", name: "Only" } }) },
  { decision: decision({ you: { mode: "keep", name: "Injected" } }) }, { decision: decision({ opponent: { mode: "other" } }) },
  { decision: decision({ policyBuild: {} }) }, { decision: { ...decision(), date: new Date() } },
];
test.each(invalidMutations)("rejects malformed closed descriptor %p", patch => {
  expect(() => immutableCustomBuildIngestTag(mutation(patch))).toThrow("game_stats_neutral_operation_invalid");
});
test("rejects getters, symbols and authority options without invoking caller code", () => {
  const getter = jest.fn(), input = mutation(); Object.defineProperty(input.decision, "policyBuild", { get: getter });
  expect(() => immutableCustomBuildIngestTag(input)).toThrow(); expect(getter).not.toHaveBeenCalled();
  expect(() => immutableCustomBuildIngestTag({ ...mutation(), [Symbol("extra")]: true })).toThrow();
  expect(() => immutableCustomBuildIngestTag(mutation(), { fenceId: uuid() })).toThrow();
});
test.each([null, "", "revision-one"])("keeps the exact original pipeline and revision=%p predicate in the owner session", async expectedRevision => {
  const h = harness(), input = mutation({ expectedRevision });
  await expect(h.writer.write(h.owner, input)).resolves.toEqual({ _id: "one" });
  expect(h.events).toEqual(["owner", "game"]);
  expect(h.games.findOneAndUpdate).toHaveBeenCalledWith({ userId, gameId: "one",
    ...(expectedRevision === null ? {} : { _customBuildRevision: expectedRevision }) },
  stamped(tagClassificationPipeline(input.decision)), { projection: { _id: 1 }, upsert: false, session: h.session });
  expect(h.session.withTransaction.mock.calls[0][1]).toMatchObject({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority", j: true } });
  expect(h.session.endSession).toHaveBeenCalledTimes(1);
});
test.each([null, "revision-one"])("preserves null-game behavior for revision=%p", async expectedRevision => {
  const h = harness(); h.games.findOneAndUpdate.mockResolvedValue(null);
  const task = h.writer.write(h.owner, mutation({ expectedRevision }));
  if (expectedRevision === null) await expect(task).resolves.toBeNull();
  else await expect(task).rejects.toMatchObject({ code: "custom_build_tag_superseded" });
});
test("copies the BSON owner, decision and empty options before a held floor", async () => {
  const h = harness(), floor = held(), originalId = new ObjectId(h.owner.id), originalEpoch = h.owner.epoch, input = mutation(), options = {};
  statsReadFloorFor.mockReturnValue(() => floor.promise);
  const task = h.writer.write(h.owner, input, options);
  h.owner.id.id.fill(0); h.owner.userId = "rebound"; h.owner.epoch = uuid(); options.fenceId = uuid();
  input.decision.you.name = "Changed"; input.expectedRevision = "newer";
  floor.resolve(new Timestamp({ t: 12, i: 1 })); await task;
  expect(h.users.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ _id: originalId, userId, gameStatsMutationEpoch: originalEpoch, _gdprMutation: { $exists: false } });
  expect(h.games.findOneAndUpdate.mock.calls[0][0]).toEqual({ userId, gameId: "one", _customBuildRevision: "revision-one" });
  expect(h.games.findOneAndUpdate.mock.calls[0][1]).toEqual(stamped(tagClassificationPipeline(decision())));
});
test("a stopped writer drains the real floor and cannot dispatch a late tag", async () => {
  const h = harness(), floor = held(); statsReadFloorFor.mockReturnValue(() => floor.promise);
  const task = h.writer.write(h.owner, mutation()), rejected = expect(task).rejects.toThrow("game_stats_writer_stopping");
  const drain = h.writer.stopAndDrain(); expect(h.writer.pending.size).toBe(1);
  floor.resolve(new Timestamp({ t: 12, i: 1 })); await rejected; await drain;
  expect(h.games.findOneAndUpdate).not.toHaveBeenCalled(); expect(h.writer.pending.size).toBe(0);
});
test.each([undefined, null, { userId, id: undefined, compatibility: false }])("a present invalid owner %p never recaptures", async statsOwner => {
  const h = harness(), capture = jest.spyOn(h.writer, "capture");
  await expect(h.custom.tagSingleGame(userId, game(), { statsOwner })).rejects.toMatchObject({ code: "game_stats_owner_unavailable" });
  expect(capture).not.toHaveBeenCalled(); expect(h.custom._iterateForClassification).not.toHaveBeenCalled();
  expect(h.games.findOneAndUpdate).not.toHaveBeenCalled();
});
test("omission captures once while a supplied same-user owner never captures", async () => {
  const h = harness(), capture = jest.spyOn(h.writer, "capture");
  await h.custom.tagSingleGame(userId, game()); expect(capture).toHaveBeenCalledTimes(1);
  capture.mockClear(); await h.custom.tagSingleGame(userId, game(), { statsOwner: h.owner }); expect(capture).not.toHaveBeenCalled();
  await expect(h.custom.tagSingleGame(userId, game(), { statsOwner: { ...h.owner, userId: "foreign" } })).rejects.toThrow("game_stats_owner_unavailable");
  expect(capture).not.toHaveBeenCalled();
});
test("the original early null return has no owner read", async () => {
  const h = harness(), capture = jest.spyOn(h.writer, "capture");
  await expect(h.custom.tagSingleGame(userId, null, { statsOwner: undefined })).resolves.toBeNull();
  expect(capture).not.toHaveBeenCalled(); expect(h.games.findOneAndUpdate).not.toHaveBeenCalled();
});
test("a held classifier uses the initial owner, revision and agent labels", async () => {
  const h = harness(), entered = held(), release = held(), payload = game(), opts = { statsOwner: h.owner, expectedRevision: "original" };
  const originalId = new ObjectId(h.owner.id), epoch = h.owner.epoch;
  h.custom._iterateForClassification = async function* () { entered.resolve(); await release.promise; yield []; };
  const task = h.custom.tagSingleGame(userId, payload, opts); await entered.promise;
  h.owner.id.id.fill(0); h.owner.epoch = uuid(); h.owner.userId = "replacement"; opts.expectedRevision = "replacement";
  payload.myBuild = "Changed"; payload.opponent.strategy = "Changed enemy"; payload.gameId = "replacement";
  release.resolve(); await task;
  expect(h.users.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ _id: originalId, userId, gameStatsMutationEpoch: epoch });
  expect(h.games.findOneAndUpdate.mock.calls[0][0]).toEqual({ userId, gameId: "one", _customBuildRevision: "original" });
  expect(h.games.findOneAndUpdate.mock.calls[0][1]).toEqual(stamped(tagClassificationPipeline(decision({
    you: { mode: "unset" }, opponent: { mode: "unset" } }))));
});
test("a held policy read uses copied nested evidence and permits explicit undefined spatial", async () => {
  const h = harness(), entered = held(), release = held(), payload = game();
  payload.presetEvidence = { schemaVersion: 1, evaluatorVersion: 1,
    you: { complete: true, baseline: "Original policy", events: [] }, opponent: { complete: true, baseline: "Original enemy policy", events: [] } };
  h.custom.presetPolicies = { current: jest.fn(() => { entered.resolve(); return release.promise; }) };
  const task = h.custom.tagSingleGame(userId, payload, { statsOwner: h.owner }); await entered.promise;
  payload.presetEvidence.you.baseline = "Rebound policy"; payload.opponent.race = "Terran"; payload.durationSec = 1;
  release.resolve({ entries: [] }); await task;
  expect(h.games.findOneAndUpdate.mock.calls[0][1]).toEqual(stamped(tagClassificationPipeline(decision({ you: { mode: "unset" }, opponent: { mode: "unset" },
    payloadBuild: "Original policy", payloadStrategy: "Original enemy policy", policyBuild: "Original policy", policyStrategy: "Original enemy policy" }))));
  expect(h.custom.presetPolicies.current).toHaveBeenCalledTimes(1);
});
