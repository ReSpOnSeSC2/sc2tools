// @ts-nocheck
"use strict";

const { ObjectId } = require("mongodb");
const { UsersService } = require("../src/services/users");
const { REQUIRED_MAINTENANCE_VERSION } = require("../src/services/maintainedGameStatsRead");
const revision = "11111111-2222-4333-8444-555555555555", epoch = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
function owner() {
  const id = new ObjectId();
  return { _id: id, userId: "owner", clerkUserId: "clerk-owner", email: "owner@example.invalid",
    gameStatsProtocolVersion: 2, gameStatsWriterStatus: "transactional", gameStatsRevision: revision,
    gameStatsMutationEpoch: epoch, gameStats: { total: 4, latest: null },
    gameStatsMaintenance: { version: REQUIRED_MAINTENANCE_VERSION, ownerId: id, revision, epoch, status: "ready" },
    preferences: { onboarding: { dismissedAt: "2026-10-27" }, replayArchive: { version: 1 } },
    battleTag: "First#1", battleTags: [" First#1 ", "Second#2", "First#1", null],
    pulseIds: [" 42 ", "7", "42", null], pulseId: "legacy-unused", region: "eu", preferredRace: "Protoss",
    displayName: "Owner", lastKnownMmr: 4100, lastKnownMmrAt: "2026-10-27", lastKnownMmrRegion: "EU", sessionAnchorAt: "2026-10-28" };
}
function fixture(row, capability = true) {
  const users = { findOne: jest.fn(async () => row), updateOne: jest.fn(), insertOne: jest.fn() };
  const games = { find: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn(), updateOne: jest.fn() };
  return { service: new UsersService({ users, games, gameStatsTransactions: capability }), users, games };
}
const expectedProfile = { sessionGapMinutes: null, battleTag: "First#1", region: "eu", preferredRace: "Protoss",
  displayName: "Owner", lastKnownMmrAt: "2026-10-27", lastKnownMmrRegion: "EU", sessionAnchorAt: "2026-10-28",
  pulseIds: ["42", "7"], pulseId: "42", battleTags: ["First#1", "Second#2"], lastKnownMmr: 4100 };

test("prepared /me envelope gets summary, onboarding and proof from ONE fresh primary owner command", async () => {
  const row = owner(), { service, users, games } = fixture(row);
  expect(await service.getMeSnapshot("owner")).toEqual({
    summary: { userId: "owner", clerkUserId: "clerk-owner", email: "owner@example.invalid" },
    statsCandidate: { total: 4, latest: null }, onboarding: { dismissedAt: "2026-10-27" },
  });
  expect(users.findOne).toHaveBeenCalledTimes(1);
  expect(users.findOne).toHaveBeenCalledWith({ userId: "owner" }, { readPreference: "primary", projection: expect.objectContaining({
    _id: 1, userId: 1, email: 1, _gdprMutation: 1, gameStatsMaintenance: 1, gameStatsMutationEpoch: 1,
    gameStatsRevision: 1, "gameStats.total": 1, "gameStats.latest": 1, "preferences.onboarding": 1,
  }) });
  expect(users.updateOne).not.toHaveBeenCalled(); expect(users.insertOne).not.toHaveBeenCalled();
  for (const call of Object.values(games)) expect(call).not.toHaveBeenCalled();
});
// The Doctor envelope gained `ingestStats` (roadmap item 76) so Sync health reads
// the rejection window from this same owner read; a row without stats maps to null.
test("prepared Doctor envelope preserves full profile DTO and archive prefs without extra owner/game work", async () => {
  const { service, users, games } = fixture(owner());
  expect(await service.getDoctorSnapshot("owner")).toEqual({ profile: expectedProfile,
    statsCandidate: { total: 4, latest: null }, replayArchivePrefs: { version: 1 }, ingestStats: null });
  expect(users.findOne).toHaveBeenCalledTimes(1);
  expect(users.findOne.mock.calls[0][1]).toEqual({ readPreference: "primary", projection: expect.objectContaining({
    _id: 1, userId: 1, battleTags: 1, pulseIds: 1, sessionGapMinutes: 1, _gdprMutation: 1, "preferences.replayArchive": 1,
    ingestStats: 1,
  }) });
  for (const call of Object.values(games)) expect(call).not.toHaveBeenCalled();
});
test("Doctor envelope rebuilds stored ingest stats from the closed code set in the same single read", async () => {
  const row = owner(), since = new Date("2026-10-28T00:00:00Z"), last = new Date("2026-10-30T00:00:00Z");
  row.ingestStats = { rejected: { validation_failed: 3, game_deleted: 2, "$where": 9, "a.b": 1, upsert_failed: -1, quarantine_failed: 1.5 },
    rejectedSince: since, lastRejectedAt: last, extra: "dropped" };
  const { service, users } = fixture(row);
  expect((await service.getDoctorSnapshot("owner")).ingestStats).toEqual({ rejected: { validation_failed: 3 }, rejectedSince: since, lastRejectedAt: last });
  expect(users.findOne).toHaveBeenCalledTimes(1);
  row.ingestStats = { rejected: "corrupt", rejectedSince: "2026-10-28", lastRejectedAt: 5 };
  expect((await service.getDoctorSnapshot("owner")).ingestStats).toEqual({ rejected: {}, rejectedSince: null, lastRejectedAt: null });
});
test("existing public getters retain their projection, mapping and metadata-free DTO", async () => {
  const { service, users } = fixture(owner());
  expect(await service.getSummary("owner")).toEqual({ userId: "owner", clerkUserId: "clerk-owner", email: "owner@example.invalid" });
  expect(users.findOne.mock.calls[0][1]).toEqual({ projection: { _id: 0, userId: 1, clerkUserId: 1, email: 1 } });
  expect(await service.getProfile("owner")).toEqual(expectedProfile);
  expect(users.findOne.mock.calls[1][1].projection._id).toBe(0);
  expect(users.findOne.mock.calls[1][1].readPreference).toBeUndefined();
  expect(users.findOne.mock.calls[1][1].projection.gameStats).toBeUndefined();
});
test("missing owner stays the original summary/empty profile with explicit unqualified stats, never a fabricated zero", async () => {
  const { service } = fixture(null);
  expect(await service.getMeSnapshot("owner")).toEqual({ summary: { userId: "owner", clerkUserId: null, email: null }, statsCandidate: null, onboarding: {} });
  expect(await service.getDoctorSnapshot("owner")).toEqual({ profile: {}, statsCandidate: null, replayArchivePrefs: {}, ingestStats: null });
  expect(await service.getSummary("owner")).toEqual({ userId: "owner", clerkUserId: null, email: null });
  expect(await service.getProfile("owner")).toEqual({});
});
test.each([undefined, null, false, 0, ""])("falsy preferences %p preserve existing {} defaults", value => {
  const row = owner(); row.preferences = { onboarding: value, replayArchive: value };
  const { service } = fixture(row);
  return Promise.all([service.getMeSnapshot("owner"), service.getDoctorSnapshot("owner")]).then(([me, doctor]) => {
    expect(me.onboarding).toEqual({}); expect(doctor.replayArchivePrefs).toEqual({});
  });
});
test("current maintenance1 remains a miss without issuing repair/count or changing the profile", async () => {
  const row = owner(); row.gameStatsMaintenance.version = 1;
  const { service, games } = fixture(row);
  expect((await service.getMeSnapshot("owner")).statsCandidate).toBeNull();
  expect(await service.getDoctorSnapshot("owner")).toEqual({ profile: expectedProfile, statsCandidate: null, replayArchivePrefs: { version: 1 }, ingestStats: null });
  for (const call of Object.values(games)) expect(call).not.toHaveBeenCalled();
});
test.each([undefined, false])("unsupported capability %p leaves even future metadata unqualified", async capability => {
  const { service } = fixture(owner(), capability);
  // Explicit undefined must not be replaced by this fixture's convenience default.
  service.db.gameStatsTransactions = capability;
  expect((await service.getMeSnapshot("owner")).statsCandidate).toBeNull();
});
test.each([{}, { id: "expired", leaseUntil: new Date(0) }, true])("truthy GDPR %p preserves Doctor/public profile503", async fence => {
  const row = owner(); row._gdprMutation = fence; const { service } = fixture(row);
  await expect(service.getProfile("owner")).rejects.toMatchObject({ status: 503, code: "gdpr_operation_busy" });
  await expect(service.getDoctorSnapshot("owner")).rejects.toMatchObject({ status: 503, code: "gdpr_operation_busy" });
  expect((await service.getMeSnapshot("owner")).statsCandidate).toBeNull();
});
test.each([null, false, 0, ""])("falsy GDPR %p preserves profile success but cannot qualify stats", async fence => {
  const row = owner(); row._gdprMutation = fence; const { service } = fixture(row);
  expect(await service.getProfile("owner")).toEqual(expectedProfile);
  expect((await service.getDoctorSnapshot("owner")).statsCandidate).toBeNull();
});
test.each([0, 14, 481, 15.5, "30", NaN, false])("invalid stored session gap %p preserves the original failure", async gap => {
  const row = owner(); row.sessionGapMinutes = gap; const { service } = fixture(row);
  await expect(service.getProfile("owner")).rejects.toMatchObject({ status: 503, code: "session_policy_invalid" });
  await expect(service.getDoctorSnapshot("owner")).rejects.toMatchObject({ status: 503, code: "session_policy_invalid" });
});
test("legacy singular identity and explicit empty identity array retain their existing distinction", async () => {
  const row = owner(); delete row.pulseIds; row.pulseId = " legacy "; row.lastKnownMmr = Infinity;
  const { service } = fixture(row);
  expect((await service.getProfile("owner")).pulseIds).toEqual(["legacy"]);
  expect((await service.getDoctorSnapshot("owner")).profile.lastKnownMmr).toBeUndefined();
  row.pulseIds = []; expect((await service.getDoctorSnapshot("owner")).profile.pulseId).toBeUndefined();
});
test("query failures escape unchanged instead of becoming fallback/zero", async () => {
  const { service, users } = fixture(owner()), error = new Error("actual Mongo failure");
  users.findOne.mockRejectedValue(error);
  await expect(service.getMeSnapshot("owner")).rejects.toBe(error);
  await expect(service.getDoctorSnapshot("owner")).rejects.toBe(error);
});
test("every envelope uses a fresh owner read and cannot carry prior candidate into a replacement owner", async () => {
  const row = owner(), replacement = owner(); replacement.gameStatsMaintenance.ownerId = row._id;
  const { service, users } = fixture(row);
  expect((await service.getMeSnapshot("owner")).statsCandidate).toEqual({ total: 4, latest: null });
  users.findOne.mockResolvedValue(replacement);
  expect((await service.getMeSnapshot("owner")).statsCandidate).toBeNull(); expect(users.findOne).toHaveBeenCalledTimes(2);
});
