// @ts-nocheck
"use strict";
const request = require("supertest");
jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
const { createHarness, SECRET } = require("./helpers/reviewsHarness");
const { claimUserDataLease } = require("../src/middleware/userDataWriteFence");
let h, originalReplayFiles, originalPlaybackArtifacts, originalGameDetails;
const ID = "controlled-replay";
const owner = "u_owner", other = "u_other";
const gamePath = () => `/v1/games/${encodeURIComponent(ID)}`;
const call = (method, path, name = "owner") => request(h.app)[method](path).set("authorization", h.bearer(name));

beforeAll(async () => {
  h = await createHarness();
  originalReplayFiles = h.services.gdpr.replayFiles;
  originalPlaybackArtifacts = h.services.gdpr.playbackArtifacts;
  originalGameDetails = h.services.gdpr.gameDetails;
});
afterAll(async () => { await h?.close(); });
beforeEach(async () => {
  jest.restoreAllMocks();
  h.services.gdpr.replayFiles = originalReplayFiles;
  h.services.gdpr.playbackArtifacts = originalPlaybackArtifacts;
  h.services.gdpr.gameDetails = originalGameDetails;
  for (const name of ["games", "gameDetails", "opponents", "users", "opponentNotes", "reviewRequests", "macroJobs", "guideSamples", "userBackups"]) await h.db[name].deleteMany({});
  await h.seedUser("owner", { displayName: "Owner" }); await h.seedUser("other", { displayName: "Other" });
  await h.seedGame("owner", { gameId: ID }); await h.seedGame("other", { gameId: ID });
  await h.db.opponents.insertMany([
    { userId: owner, pulseId: SECRET.pulseId, displayNameSample: SECRET.name, wins: 0, losses: 1, gameCount: 1 },
    { userId: other, pulseId: SECRET.pulseId, displayNameSample: SECRET.name, wins: 0, losses: 1, gameCount: 1 },
    { userId: owner, pulseId: "untouched-rival", displayNameSample: "Unrelated", wins: 20, losses: 10, gameCount: 30, sentinel: "keep" },
  ]);
});

test("hide/unhide changes only this owner's contribution and keeps private replay detail readable", async () => {
  const samples = h.services.guideSamples;
  await h.db.guideSamples.insertMany([{ ...samples._key(owner, ID), sentinel: "owner" }, { ...samples._key(other, ID), sentinel: "other" }]);
  const beforeOther = await h.db.games.findOne({ userId: other, gameId: ID });
  const response = await call("patch", gamePath()).send({ excluded: true, reason: "friend_played" });
  expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(await h.db.games.findOne({ userId: owner, gameId: ID })).toMatchObject({ excluded: true, exclusionReason: "friend_played" });
  expect(await h.db.games.findOne({ userId: other, gameId: ID })).toEqual(beforeOther);
  expect(await h.services.aggregations.maps(owner, {})).toEqual([]);
  expect((await h.services.aggregations.maps(other, {}))[0].total).toBe(1);
  expect((await call("get", gamePath())).status).toBe(200);
  expect((await call("get", "/v1/replays")).body.items).toEqual([]);
  expect((await call("get", "/v1/replays?include_excluded=1&excluded_only=1")).body.items[0]).toMatchObject({ gameId: ID, excluded: true });
  expect(await h.db.guideSamples.findOne(samples._key(owner, ID))).toMatchObject({ excluded: true, sentinel: "owner" });
  expect(await h.db.guideSamples.findOne(samples._key(other, ID))).not.toHaveProperty("excluded");
  expect(await h.db.opponents.findOne({ userId: owner, pulseId: SECRET.pulseId })).toBeNull();
  expect(await h.db.opponents.findOne({ userId: owner, pulseId: "untouched-rival" })).toMatchObject({ sentinel: "keep", gameCount: 30 });
  expect((await call("get", "/v1/games/hidden")).body.items[0]).toMatchObject({ gameId: ID, pendingDeletion: false });
  expect((await call("patch", gamePath()).send({ excluded: false })).status).toBe(200);
  expect((await h.services.aggregations.maps(owner, {}))[0].total).toBe(1);
  expect(await h.db.opponents.findOne({ userId: owner, pulseId: SECRET.pulseId })).toMatchObject({ gameCount: 1, losses: 1 });
  expect(await h.db.guideSamples.findOne(samples._key(owner, ID))).not.toHaveProperty("excluded");
});

test("validates hide reasons, owner scope and exact typed confirmation without touching another copy", async () => {
  expect((await request(h.app).patch(gamePath()).send({ excluded: true, reason: "other" })).status).toBe(401);
  expect((await call("patch", "/v1/games/not-owned").send({ excluded: true, reason: "other" })).status).toBe(404);
  for (const body of [{ excluded: true, reason: "secret arbitrary reason" }, { excluded: true, reason: "other", userId: other }, { excluded: "true" }]) {
    expect((await call("patch", gamePath()).send(body)).status).toBe(400);
  }
  expect((await call("delete", gamePath()).send({ confirmation: "delete game" })).status).toBe(400);
  expect((await call("delete", gamePath()).send({ confirmation: "DELETE GAME", gameId: "other" })).status).toBe(400);
  expect(await h.db.games.countDocuments({ gameId: ID, _deleted: true })).toBe(0);
});

test("single delete removes payloads, revokes grants, and retains only an owner-scoped suppression marker", async () => {
  const replay = { delete: jest.fn(async () => {}) }, playback = { deleteMany: jest.fn(async () => {}) };
  h.services.gdpr.replayFiles = replay; h.services.gdpr.playbackArtifacts = playback;
  await h.db.reviewRequests.insertOne({ _id: "controlled-review", userId: owner, gameId: ID, status: "open", activeKey: "active", listed: true, indexable: true });
  await h.db.macroJobs.insertMany([{ userId: owner, gameId: ID }, { userId: owner, gameId: "unrelated-job" }]);
  await h.db.guideSamples.insertOne({ ...h.services.guideSamples._key(owner, ID), marker: "remove" });
  const response = await call("delete", gamePath()).send({ confirmation: "DELETE GAME" });
  expect(response.status).toBe(200); expect(response.body).toMatchObject({ gameId: ID, deleted: true });
  const marker = await h.db.games.findOne({ userId: owner, gameId: ID });
  expect(Object.keys(marker).sort()).toEqual(["_deleted", "_id", "_schemaVersion", "deletedAt", "excluded", "gameId", "userId"].sort());
  expect(marker).toMatchObject({ _deleted: true, excluded: true });
  expect(await h.db.gameDetails.findOne({ userId: owner, gameId: ID })).toBeNull();
  expect(await h.db.gameDetails.findOne({ userId: other, gameId: ID })).not.toBeNull();
  expect(await h.db.guideSamples.findOne(h.services.guideSamples._key(owner, ID))).toBeNull();
  expect(await h.db.macroJobs.findOne({ userId: owner, gameId: "unrelated-job" })).not.toBeNull();
  expect(await h.db.reviewRequests.findOne({ _id: "controlled-review" })).toMatchObject({ status: "closed", listed: false, indexable: false, closedReason: "game_unavailable" });
  expect(await h.services.games.existingGameIds(owner, [ID])).toEqual([ID]);
  expect(await h.services.games.get(owner, ID)).toBeNull();
  expect(await h.services.perGame.hasGame(owner, ID)).toBe(false);
  expect(await h.services.replayLibrary.getDetail(owner, ID)).toBeNull();
  expect((await call("get", "/v1/games/hidden")).body.items).toEqual([]);
  expect((await call("get", "/v1/replays?include_excluded=1")).body.items).toEqual([]);
  expect(replay.delete).toHaveBeenCalledTimes(2);
  expect(replay.delete.mock.calls.every(args => args[0] === owner && args[1] === ID)).toBe(true);
  expect(playback.deleteMany).toHaveBeenCalledTimes(2);
  expect(playback.deleteMany.mock.calls.every(args => args[0] === owner && JSON.stringify(args[1]) === JSON.stringify([ID]))).toBe(true);
  expect((await call("delete", gamePath()).send({ confirmation: "DELETE GAME" })).status).toBe(200);
  expect(await h.db.games.findOne({ userId: other, gameId: ID })).not.toHaveProperty("_deleted");
});

test("permanent markers reject forced ingest and untrusted uploads cannot unhide a replay", async () => {
  await h.services.gameControls.setExcluded(owner, ID, { excluded: true, reason: "other" });
  const game = { gameId: ID, date: "2026-09-01T10:10:40Z", result: "Defeat", myRace: "Protoss", map: "Alcyone LE", excluded: false, _deleted: false, buildLog: ["[0:10] Pylon"] };
  expect(await h.services.games.upsertWithRevision(owner, game)).toMatchObject({ created: false, excluded: true });
  expect(await h.db.games.findOne({ userId: owner, gameId: ID })).toMatchObject({ excluded: true });
  await h.services.gameControls.deleteGame(owner, ID);
  const details = jest.spyOn(h.services.gameDetails, "upsert");
  await expect(h.services.games.upsertWithRevision(owner, game)).rejects.toMatchObject({ code: "game_deleted" });
  expect(details).not.toHaveBeenCalled();
  const response = await call("post", "/v1/games").send({ games: [game] });
  expect(response.status).toBe(202);
  expect(response.body.accepted).toEqual([]);
  expect(response.body.rejected[0]).toMatchObject({ gameId: ID, retryable: false, errors: ["game_deleted"] });
  await drainHttpWrites();
  const resumed = await call("post", "/v1/games").send({ games: [{ ...game, isResumedFromReplay: true }] });
  expect(resumed.status).toBe(202);
  expect(resumed.body.rejected[0]).toMatchObject({ gameId: ID, retryable: false, errors: ["game_deleted"] });
  await drainHttpWrites();
});

test("hidden control pagination is private and never returns a completed tombstone as a replay", async () => {
  const rows = Array.from({ length: 27 }, (_, i) => ({ userId: owner, gameId: `hidden-${String(i).padStart(2, "0")}`, excluded: true, map: `Map ${i}`, date: new Date(), exclusionReason: "other" }));
  await h.db.games.insertMany([...rows, { userId: owner, gameId: "gone-complete", _deleted: true, excluded: true }, { userId: owner, gameId: "gone-pending", _deleted: true, excluded: true, _cleanupRequired: { replay: true } }, { userId: other, gameId: "foreign-secret", excluded: true }]);
  const first = await call("get", "/v1/games/hidden"); expect(first.status).toBe(200); expect(first.body.items).toHaveLength(25);
  expect(first.body.items[0]).toMatchObject({ gameId: "gone-pending", pendingDeletion: true });
  expect(first.body.items.every(row => !["gone-complete", "foreign-secret"].includes(row.gameId))).toBe(true);
  expect(Object.keys(first.body.items[0]).sort()).toEqual(["date", "gameId", "map", "opponent", "pendingDeletion", "reason"]);
  const next = await call("get", `/v1/games/hidden?cursor=${first.body.nextCursor}`); expect(next.body.items).toHaveLength(3); expect(next.body.nextCursor).toBeNull();
  expect((await call("get", "/v1/games/hidden?cursor=malformed")).status).toBe(400);
});

test("account catalog uses only this owner's live account metadata and retains hidden account identities", async () => {
  await h.db.users.updateOne({ userId: owner }, { $set: { pulseIds: ["1-S2-1-111111"] } });
  await h.db.games.updateOne({ userId: owner, gameId: ID }, { $set: { excluded: true, myLeagueId: 4 } });
  await h.db.games.insertMany([
    { userId: owner, gameId: "latest-account", date: new Date(), myToonHandle: "2-S2-1-222", myMmr: 5000, myLeagueId: 5 },
    { userId: owner, gameId: "bad-account", date: new Date(), myToonHandle: "not-a-toon", myMmr: 999999 },
    { userId: owner, gameId: "pending-account", date: new Date(), myToonHandle: "3-S2-1-333", _deletionPending: true },
    { userId: other, gameId: "foreign-account", date: new Date(), myToonHandle: "5-S2-1-555" },
  ]);
  const response = await call("get", "/v1/game-accounts"); expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.body.items).toEqual([
    { handle: "2-S2-1-222", label: "Most recent", region: "EU", mmr: 5000, leagueId: 5 },
    { handle: "1-S2-1-111111", label: "Main", region: "NA", mmr: 4130, leagueId: 4 },
  ]);
  expect((await call("get", "/v1/replays?accounts=1-S2-1-111111&include_excluded=1")).body.items).toHaveLength(1);
  expect((await call("get", "/v1/replays?accounts=1-S2-1-111111,malformed")).status).toBe(400);
});

test("cleanup errors retain retry state, never report success or permit Unhide", async () => {
  const replay = { delete: jest.fn().mockRejectedValueOnce(new Error("object_cleanup_failed")).mockResolvedValue(undefined) };
  h.services.gdpr.replayFiles = replay;
  await expect(h.services.gameControls.deleteGame(owner, ID)).rejects.toThrow("object_cleanup_failed");
  expect(await h.db.games.findOne({ userId: owner, gameId: ID })).toMatchObject({ _deletionPending: true, excluded: true, map: "Alcyone LE" });
  expect((await call("get", "/v1/games/hidden")).body.items[0]).toMatchObject({ pendingDeletion: true });
  await expect(h.services.gameControls.setExcluded(owner, ID, { excluded: false })).rejects.toMatchObject({ code: "game_deletion_pending" });
  expect(await h.services.gameControls.deleteGame(owner, ID)).toMatchObject({ deleted: true });
});

test("post-cleanup failure preserves only cleanup requirements and fails closed if a required store disappears", async () => {
  const replay = { delete: jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("post_cleanup_failed")).mockResolvedValue(undefined) };
  h.services.gdpr.replayFiles = replay;
  await expect(h.services.gameControls.deleteGame(owner, ID)).rejects.toThrow("post_cleanup_failed");
  const marker = await h.db.games.findOne({ userId: owner, gameId: ID });
  expect(marker).toMatchObject({ _deleted: true, _cleanupRequired: { replay: true } });
  expect(marker).not.toHaveProperty("map");
  h.services.gdpr.replayFiles = null;
  await expect(h.services.gameControls.deleteGame(owner, ID)).rejects.toMatchObject({ code: "game_cleanup_unavailable" });
  h.services.gdpr.replayFiles = replay;
  await h.services.gameControls.deleteGame(owner, ID);
  expect(await h.db.games.findOne({ userId: owner, gameId: ID })).not.toHaveProperty("_cleanupRequired");
});

test("pre-tombstone cleanup keeps required store flags across a retry with a missing backend", async () => {
  const replay = { delete: jest.fn(async () => {}) }, playback = { deleteMany: jest.fn().mockRejectedValueOnce(new Error("playback_backend_failed")).mockResolvedValue(undefined) };
  h.services.gdpr.replayFiles = replay; h.services.gdpr.playbackArtifacts = playback;
  await expect(h.services.gameControls.deleteGame(owner, ID)).rejects.toThrow("playback_backend_failed");
  expect(await h.db.games.findOne({ userId: owner, gameId: ID })).toMatchObject({ _deletionPending: true, _cleanupRequired: { replay: true, playback: true, details: true } });
  h.services.gdpr.playbackArtifacts = null;
  await expect(h.services.gameControls.deleteGame(owner, ID)).rejects.toMatchObject({ status: 503, code: "game_cleanup_unavailable" });
  expect(await h.db.games.findOne({ userId: owner, gameId: ID })).not.toHaveProperty("_deleted");
  h.services.gdpr.playbackArtifacts = playback;
  expect(await h.services.gameControls.deleteGame(owner, ID)).toMatchObject({ deleted: true });
  expect(await h.db.games.findOne({ userId: owner, gameId: ID })).not.toHaveProperty("_cleanupRequired");
});

test("existing artifact markers fail closed even when that store is absent on the first delete", async () => {
  h.services.gdpr.replayFiles = { delete: jest.fn(async () => {}) };
  h.services.gdpr.playbackArtifacts = null;
  await h.db.games.updateOne({ userId: owner, gameId: ID }, { $set: { playbackArtifact: { artifactId: "existing-private-object" } } });
  await expect(h.services.gameControls.deleteGame(owner, ID)).rejects.toMatchObject({ status: 503, code: "game_cleanup_unavailable" });
  expect(await h.db.games.findOne({ userId: owner, gameId: ID })).not.toHaveProperty("_deletionPending");
});

test.each(["playback", "details"])("full erasure retains a %s cleanup marker when its required backend is missing", async missing => {
  const replay = { delete: jest.fn(async () => {}), deleteAllForUser: jest.fn(async () => {}) };
  const playback = { deleteMany: jest.fn(async () => {}), deleteAllForUser: jest.fn(async () => {}) };
  h.services.gdpr.replayFiles = replay; h.services.gdpr.playbackArtifacts = playback;
  await h.db.games.insertOne({ userId: owner, gameId: "failed-cleanup", _deleted: true, excluded: true, _cleanupRequired: { [missing]: true } });
  if (missing === "playback") h.services.gdpr.playbackArtifacts = null;
  else h.services.gdpr.gameDetails = null;
  await expect(h.services.gdpr.deleteAll(owner, { identityAlreadyDeleted: true })).rejects.toMatchObject({ status: 503, code: "game_cleanup_unavailable" });
  expect(await h.db.games.findOne({ userId: owner, gameId: "failed-cleanup" })).toMatchObject({ _cleanupRequired: { [missing]: true } });
  expect(await h.db.users.findOne({ userId: owner })).not.toHaveProperty("_gdprMutation");
  expect(replay.deleteAllForUser).not.toHaveBeenCalled();
  h.services.gdpr.playbackArtifacts = playback; h.services.gdpr.gameDetails = originalGameDetails;
  await h.services.gdpr.deleteAll(owner, { identityAlreadyDeleted: true });
  expect(await h.db.games.countDocuments({ userId: owner })).toBe(0);
  expect(await h.db.users.findOne({ userId: owner })).toBeNull();
  expect(await h.db.games.countDocuments({ userId: other })).toBe(1);
  expect(replay.deleteAllForUser).toHaveBeenCalledWith(owner); expect(playback.deleteAllForUser).toHaveBeenCalledWith(owner);
});

test("another game's missing-backend marker does not block a correctly scoped single delete", async () => {
  h.services.gdpr.replayFiles = { delete: jest.fn(async () => {}) }; h.services.gdpr.playbackArtifacts = null;
  const marker = { userId: owner, gameId: "unrelated-pending", _deleted: true, excluded: true, _cleanupRequired: { playback: true } };
  await h.db.games.insertOne(marker);
  await expect(h.services.gameControls.deleteGame(owner, ID)).resolves.toMatchObject({ deleted: true });
  expect(await h.db.games.findOne({ userId: owner, gameId: "unrelated-pending" })).toMatchObject(marker);
});

test("a delayed detail writer cannot recreate a deleted blob or metadata row", async () => {
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  const store = h.services.gameDetails.store;
  const originalWrite = store.write.bind(store);
  let entered = false;
  jest.spyOn(store, "write").mockImplementation(async (...args) => { entered = true; await paused; return originalWrite(...args); });
  const writing = h.services.gameDetails.upsert(owner, ID, new Date(), { buildLog: ["[0:10] Gateway"] });
  await until(() => entered);
  await h.services.gameControls.deleteGame(owner, ID);
  release();
  await expect(writing).rejects.toMatchObject({ code: "game_deleted" });
  expect(await h.db.gameDetails.findOne({ userId: owner, gameId: ID })).toBeNull();
  expect(await h.db.games.findOne({ userId: owner, gameId: ID })).toMatchObject({ _deleted: true });
});

test("exclusive deletion waits for the real authenticated writer lease and releases its fence", async () => {
  const lease = await claimUserDataLease(h.db.users, owner);
  let settled = false;
  const deleting = h.services.gameControls.deleteGame(owner, ID).finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 75));
  expect(settled).toBe(false);
  expect(await h.db.games.findOne({ userId: owner, gameId: ID })).not.toHaveProperty("_deleted");
  await lease.release(); await deleting;
  expect(await h.db.users.findOne({ userId: owner })).not.toHaveProperty("_gdprMutation");
});

test("old snapshot restore preserves deletion markers and recounts its affected opponent only", async () => {
  const snapshot = await h.services.gdpr.snapshot(owner);
  await h.services.gameControls.deleteGame(owner, ID);
  const markerBefore = await h.db.games.findOne({ userId: owner, gameId: ID });
  const preview = await h.services.gdpr.backups.preview(owner, snapshot.id);
  expect(preview.games.added).toBe(0);
  await h.services.gdpr.restoreSnapshot(owner, snapshot.id, preview.currentRevision);
  expect(await h.db.games.findOne({ userId: owner, gameId: ID })).toEqual(markerBefore);
  expect(await h.db.opponents.findOne({ userId: owner, pulseId: SECRET.pulseId })).toBeNull();
  const exported = await h.services.gdpr.export(owner);
  expect(exported.data.games.find(game => game.gameId === ID)).toMatchObject({ _deleted: true });
  expect(exported.data.games.every(game => game.userId === owner)).toBe(true);
});

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("fixture did not settle"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function drainHttpWrites() {
  const deadline = Date.now() + 5000;
  while ((await h.db.users.findOne({ userId: owner }))?._dataMutations?.length) {
    if (Date.now() > deadline) throw new Error("HTTP fixture lease did not release");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
