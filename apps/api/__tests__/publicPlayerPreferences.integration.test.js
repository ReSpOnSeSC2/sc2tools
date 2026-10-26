// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { UsersService } = require("../src/services/users");
const { PublicPlayerService } = require("../src/services/publicPlayer");
const { PublicPlayerPreferencesService } = require("../src/services/publicPlayerPreferences");
const { extraAggregates } = require("../src/services/publicPlayerAggregates");
const { PublicProfileService } = require("../src/services/publicProfile");
const { SeasonsService } = require("../src/services/seasons");
const { GdprService } = require("../src/services/gdpr");
const { restoreUserSettings } = require("../src/services/userBackups");
const { publicPlayerSitemap } = require("../src/services/publicPlayerSitemap");
const { ReviewerReputationService } = require("../src/services/reviewerReputation");
const { SECTION_KEYS, publicPlayerSettings, validPlayerSlug } = require("../src/util/publicPlayerConfig");
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SLUG = "sample-player-0123456789";
const allOff = Object.fromEntries(SECTION_KEYS.map(key => [key, false]));
const input = (overrides = {}) => ({ enabled: false, slug: SLUG, revision: 0, ...allOff, ...overrides });

// eslint-disable-next-line max-lines-per-function -- Suite registration groups independent real-Mongo privacy/CAS cases, not one runtime operation.
describe("public player owner controls and real canonical index", () => {
  let mongo, db, users, players, preferences, community;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "sc2tools_test_public_player_preferences" });
    users = new UsersService(db);
    community = { getAuthor: jest.fn(async () => null) };
    const profile = { _mainRace: async () => null, reviewerReputation: null };
    players = new PublicPlayerService(db, { community, profile, aggregations: { summary: async () => ({}) }, builds: { list: async () => [] }, replayLibrary: { list: async () => ({ summary: { total: 0 } }) } });
    preferences = new PublicPlayerPreferencesService(db, { community, resolveLegacy: id => players.resolve(id) });
    users.publicPlayerIdentity = id => players.identity(id);
  });
  afterAll(async () => { if (db) await db.close(); if (mongo) await mongo.stop(); });
  beforeEach(async () => {
    await db.users.deleteMany({}); await db.games.deleteMany({}); await db.communityBuilds.deleteMany({});
    await db.reviewComments.deleteMany({}); await db.reviewRequests.deleteMany({});
    community.getAuthor.mockReset().mockResolvedValue(null);
    await db.users.insertOne({ userId: ID, clerkUserId: "private-clerk-a", email: "private@example.invalid", displayName: "Sample Player", battleTag: "Private#1234",
      replaySharing: { enabled: false, slug: SLUG }, preferences: { misc: { defaultTab: "trends" } } });
  });

  test("pure owner reads and availability allocate nothing for a private user", async () => {
    await db.users.updateOne({ userId: ID }, { $unset: { "replaySharing.slug": "" } });
    const before = await db.users.findOne({ userId: ID });
    expect(await preferences.get(ID)).toMatchObject({ enabled: false, legacyPublic: false, slug: null, ...allOff });
    expect(await preferences.availability(ID, "new-player-0123456789")).toMatchObject({ available: true });
    expect(await db.users.findOne({ userId: ID })).toEqual(before);
  });

  test("first explicit link creation is server-random and leaves all publication off", async () => {
    await db.users.updateOne({ userId: ID }, { $unset: { "replaySharing.slug": "" } });
    const state = await preferences.set(ID, input({ slug: null }));
    expect(validPlayerSlug(state.slug)).toBe(state.slug); expect(state.slug).toMatch(/^sample-player-[a-f0-9]{10}$/);
    expect(state).toMatchObject({ enabled: false, replaySharingEnabled: false, legacyPublic: false, ...allOff });
    expect(state.renameAvailableAt).toBeNull();
    expect((await db.users.findOne({ userId: ID })).publicProfile).not.toHaveProperty("slug");
  });

  test("profile enable changes no replay switch or private profile fields", async () => {
    const before = await db.users.findOne({ userId: ID });
    const state = await preferences.set(ID, input({ enabled: true, showRecentForm: true }));
    expect(state.enabled).toBe(true); expect(state.replaySharingEnabled).toBe(false);
    const after = await db.users.findOne({ userId: ID });
    for (const key of ["clerkUserId", "email", "battleTag", "displayName", "preferences", "replaySharing"]) expect(after[key]).toEqual(before[key]);
  });

  test("the first explicit OFF choice overrides existing named legacy publications", async () => {
    community.getAuthor.mockResolvedValue({ displayName: "Public author", builds: [], totalBuilds: 1 });
    expect((await preferences.get(ID)).legacyPublic).toBe(true);
    await preferences.set(ID, input());
    expect(await players.get(SLUG)).toBeNull();
    const raw = await db.users.findOne({ userId: ID });
    expect(raw.publicProfile.enabled).toBe(false); expect(raw.replaySharing.enabled).toBe(false);
  });

  test("new namespace assignment rejects reserved bases and suffix changes", async () => {
    await expect(preferences.set(ID, input({ slug: "admin-0123456789" }))).rejects.toMatchObject({ code: "invalid_player_slug" });
    await expect(preferences.set(ID, input({ slug: "other-prefix-aaaaaaaaaa" }))).rejects.toMatchObject({ code: "player_slug_suffix" });
    await expect(preferences.set(ID, input({ slug: "UPPER-0123456789" }))).rejects.toMatchObject({ code: "invalid_player_slug" });
    expect((await db.users.findOne({ userId: ID })).publicProfile).toBeUndefined();
  });

  test("an old reserved-prefix address remains readable and reusable", async () => {
    await db.users.updateOne({ userId: ID }, { $set: { "replaySharing.slug": "admin-0123456789" } });
    await expect(preferences.set(ID, input({ enabled: true, slug: "admin-0123456789" }))).resolves.toMatchObject({ slug: "admin-0123456789", enabled: true });
    expect((await players.get("admin-0123456789")).handle).toBe("admin-0123456789");
  });

  test("unknown fields, strings for booleans and spoofed owner ids fail AJV validation", async () => {
    for (const body of [input({ userId: OTHER }), input({ enabled: "true" }), { ...input(), showMaps: undefined }]) {
      await expect(preferences.set(ID, body)).rejects.toMatchObject({ code: "invalid_public_profile" });
    }
  });

  test("a real unique-index conflict preserves the user's draft target and all flags", async () => {
    const requested = "other-name-0123456789";
    await db.users.insertOne({ userId: OTHER, replaySharing: { slug: requested, enabled: false } });
    await expect(preferences.set(ID, input({ slug: requested, enabled: true }))).rejects.toMatchObject({ status: 409, code: "player_slug_unavailable" });
    expect((await db.users.findOne({ userId: ID })).replaySharing.slug).toBe(SLUG);
  });

  test("rename is explicit, retains suffix, respects 30-day cooldown and changes no archive flag", async () => {
    const renamed = await preferences.set(ID, input({ slug: "renamed-player-0123456789" }));
    expect(renamed.slug).toBe("renamed-player-0123456789"); expect(renamed.renameAvailableAt).toBeTruthy();
    await expect(preferences.set(ID, input({ slug: "again-0123456789", revision: renamed.revision }))).rejects.toMatchObject({ code: "player_slug_cooldown" });
    await db.users.updateOne({ userId: ID }, { $set: { "publicProfile.slugChangedAt": new Date(Date.now() - 31 * 86_400_000) } });
    await expect(preferences.set(ID, input({ slug: "again-0123456789", revision: renamed.revision }))).resolves.toMatchObject({ slug: "again-0123456789", replaySharingEnabled: false });
  });

  test("an active archive prevents a profile rename instead of silently moving its URL", async () => {
    await db.users.updateOne({ userId: ID }, { $set: { "replaySharing.enabled": true } });
    await expect(preferences.set(ID, input({ slug: "moved-0123456789" }))).rejects.toMatchObject({ code: "replay_link_active" });
    expect((await db.users.findOne({ userId: ID })).replaySharing).toEqual({ enabled: true, slug: SLUG });
  });

  test("concurrent settings saves have one winner, not last-response-wins", async () => {
    const saved = await Promise.allSettled([preferences.set(ID, input({ enabled: true })), preferences.set(ID, input({ showMaps: true }))]);
    expect(saved.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(saved.find(item => item.status === "rejected").reason.code).toBe("public_profile_conflict");
    expect((await preferences.get(ID)).revision).toBe(1);
  });
  test("a committed privacy save succeeds even when optional cache purge fails", async () => {
    const notify = jest.fn(() => { throw new Error("Synthetic optional purge unavailable"); });
    const isolated = new PublicPlayerPreferencesService(db, { community, onPublicChanged: notify });
    community.getAuthor.mockResolvedValueOnce(null).mockRejectedValue(new Error("No postcommit author read allowed"));
    await expect(isolated.set(ID, input({ enabled: true }))).resolves.toMatchObject({ enabled: true, revision: 1 });
    expect(community.getAuthor).toHaveBeenCalledTimes(1);
    expect((await db.users.findOne({ userId: ID })).publicProfile.enabled).toBe(true);
  });

  test("concurrent first archive enable and profile link create converge without enabling the other surface", async () => {
    await db.users.updateOne({ userId: ID }, { $unset: { "replaySharing.slug": "" } });
    const results = await Promise.allSettled([users.setReplaySharing(ID, true), preferences.set(ID, input({ slug: null }))]);
    const user = await db.users.findOne({ userId: ID });
    expect(validPlayerSlug(user.replaySharing.slug)).toBe(user.replaySharing.slug);
    expect(user.replaySharing.enabled).toBe(true);
    expect(user.publicProfile?.enabled === true).toBe(false);
    expect(results.some(item => item.status === "fulfilled")).toBe(true);
    expect((await users.getReplaySharing(ID)).handle).toBe(user.replaySharing.slug);
  });

  test("legacy UUID archive alias requires sharing ON and returns only a canonical identity", async () => {
    expect(await users.resolveReplaySharing(ID)).toBeNull();
    await users.setReplaySharing(ID, true);
    const shared = await users.resolveReplaySharing(ID);
    expect(shared.profile).toEqual({ handle: SLUG, displayName: "Sample Player" });
    expect(JSON.stringify(shared.profile)).not.toContain(ID);
    await users.setReplaySharing(ID, false);
    expect(await users.resolveReplaySharing(ID)).toBeNull();
  });

  test("a revoked legacy opaque share id never regains access through profile publication", async () => {
    const alias = "a".repeat(32);
    await db.users.updateOne({ userId: ID }, { $set: { "replaySharing.enabled": true, "replaySharing.shareId": alias } });
    expect(await users.resolveReplaySharing(alias)).toBeTruthy();
    await users.setReplaySharing(ID, false);
    await preferences.set(ID, input({ enabled: true }));
    expect(await users.resolveReplaySharing(alias)).toBeNull();
  });

  test("the old public profile reader also honors explicit OFF", async () => {
    community.getAuthor.mockResolvedValue({ displayName: "Public author", builds: [], totalBuilds: 1 });
    await preferences.set(ID, input());
    const legacy = new PublicProfileService(db, { community, aggregations: { summary: jest.fn() }, builds: { list: jest.fn() } });
    expect(await legacy.getPublicProfile(ID)).toBeNull();
  });
  test("canonical sitemap excludes explicit OFF, archive-only and unassigned legacy addresses without writes", async () => {
    await preferences.set(ID, input({ enabled: true }));
    const hidden = "33333333-3333-4333-8333-333333333333", archiveOnly = "44444444-4444-4444-8444-444444444444";
    const unassigned = "66666666-6666-4666-8666-666666666666";
    await db.users.insertMany([
      { userId: OTHER, clerkUserId: "synthetic-legacy", replaySharing: { slug: "legacy-public-aaaaaaaaaa", enabled: false } },
      { userId: hidden, clerkUserId: "synthetic-hidden", publicProfile: { enabled: false }, replaySharing: { slug: "hidden-bbbbbbbbbb", enabled: true } },
      { userId: archiveOnly, clerkUserId: "synthetic-archive", replaySharing: { slug: "archive-only-cccccccccc", enabled: true } },
      { userId: unassigned, clerkUserId: "synthetic-unassigned" },
    ]);
    await db.communityBuilds.insertMany([
      { slug: "legacy", ownerUserId: OTHER, removed: false, authorName: "Named legacy", publishedAt: new Date("2026-10-20") },
      { slug: "hidden", ownerUserId: hidden, removed: false, authorName: "Still public build", publishedAt: new Date("2026-10-21") },
      { slug: "unassigned", ownerUserId: unassigned, removed: false, authorName: "Named unassigned", publishedAt: new Date("2026-10-21") },
    ]);
    const writer = jest.spyOn(db.users, "updateOne");
    try {
      const result = await publicPlayerSitemap(db);
      expect(result.items.map(item => item.handle)).toEqual(["legacy-public-aaaaaaaaaa", SLUG]);
      expect(writer).not.toHaveBeenCalled();
      for (const privateId of [ID, OTHER, hidden, archiveOnly, unassigned]) expect(JSON.stringify(result)).not.toContain(privateId);
    } finally { writer.mockRestore(); }
  });

  test("public settings are part of ordinary user export and excluded from profile restore keys", async () => {
    const state = await preferences.set(ID, input({ enabled: true }));
    expect(publicPlayerSettings(await db.users.findOne({ userId: ID }))).toMatchObject({ enabled: true, revision: state.revision });
    const exported = await new GdprService(db).export(ID);
    expect(exported.user.publicProfile).toMatchObject({ enabled: true, revision: state.revision });
    await db.users.updateOne({ userId: ID }, { $set: { "publicProfile.enabled": false } });
    await restoreUserSettings(db.users, ID, "accountProfile", { data: { displayName: "Restored profile", publicProfile: { enabled: true }, replaySharing: { enabled: true } } });
    const after = await db.users.findOne({ userId: ID });
    expect(after.displayName).toBe("Restored profile");
    expect(after.publicProfile.enabled).toBe(false); expect(after.replaySharing.enabled).toBe(false);
  });
  test("public reviewer matchup sampling is bounded before deduplication and reports its cap", async () => {
    await db.users.updateOne({ userId: ID }, { $set: { reviewer: { reviews: 2101, karma: 5 } } });
    await db.reviewComments.insertMany(Array.from({ length: 2101 }, (_, index) => ({ authorId: ID, requestId: `sample-review-${index}`, parentId: null, isAskerComment: false, status: "visible", createdAt: new Date(1_700_000_000_000 + index) })));
    await db.reviewRequests.insertMany(Array.from({ length: 2101 }, (_, index) => ({ _id: `sample-review-${index}`, userId: OTHER, gameId: `sample-game-${index}`, matchup: "PvT", status: "answered", hidden: false })));
    const pulse = { getCurrentMmr: jest.fn() }, seasons = { list: jest.fn() };
    const section = await new ReviewerReputationService(db, { pulse, seasons }).publicSection(ID, { maxTimeMS: 3000 });
    expect(section.matchupsReviewed).toEqual([{ matchup: "PvT", count: 2000 }]);
    expect(section.matchupsSampled).toBe(true); expect(section.matchupsSampleLimit).toBe(2000);
    expect(pulse.getCurrentMmr).not.toHaveBeenCalled(); expect(seasons.list).not.toHaveBeenCalled();
  });
});

describe("opt-in extra aggregate proof", () => {
  let mongo, db;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "sc2tools_test_public_player_extras" }); });
  afterAll(async () => { if (db) await db.close(); if (mongo) await mongo.stop(); });
  test("map floor, slim MMR averages, cached season windows and owner/deletion guards", async () => {
    await db.games.insertMany([
      ...Array.from({ length: 10 }, (_, i) => ({ userId: ID, gameId: `public-${i}`, date: new Date("2026-10-20"), myRace: "Protoss", myMmr: 4000 + i * 10, map: "Ten Games", result: i < 7 ? "victory" : "defeat" })),
      { userId: ID, gameId: "small", date: new Date("2026-10-20"), myRace: "Protoss", myMmr: 4100, map: "Small sample", result: "win" },
      { userId: OTHER, gameId: "other", date: new Date("2026-10-20"), myRace: "Terran", myMmr: 9000, map: "Ten Games", result: "win" },
      { userId: ID, gameId: "deleted", date: new Date("2026-10-20"), myMmr: 9000, map: "Ten Games", result: "win", _deleted: true },
    ]);
    const result = await extraAggregates(db, ID, { showMaps: true, showMmrHistory: true, showSeasons: true }, new Date("2026-10-25"), [{ number: 68, start: new Date("2026-09-01"), end: new Date("2026-12-01") }]);
    expect(result.maps).toEqual([{ name: "Ten Games", games: 10, wins: 7, losses: 3 }]);
    expect(result.mmrHistory).toEqual([{ date: "2026-10-19T00:00:00.000Z", mmr: 4050, games: 11 }]);
    expect(result.seasons).toEqual([{ season: 68, games: 11, wins: 8, losses: 3, peakMmr: 4100, mainRace: "P" }]);
    expect(result.seasonDataAvailable).toBe(true);
  });
  test("cold season cache is honest and makes no provider request", async () => {
    const fetchImpl = jest.fn(() => { throw new Error("No network permitted"); });
    const seasons = new SeasonsService({ fetchImpl });
    expect(seasons.cachedWindows()).toEqual([]); expect(fetchImpl).not.toHaveBeenCalled();
    expect(await extraAggregates(db, ID, { showSeasons: true }, new Date(), seasons.cachedWindows())).toEqual({ seasons: [], seasonDataAvailable: false });
  });
  test("cached season windows use global ids instead of annual numbers and include the open current season", () => {
    const seasons = new SeasonsService({ now: () => Date.parse("2026-10-25"), fetchImpl: jest.fn() });
    seasons._cache = { fetchedAt: 1, items: [
      { battlenetId: 65, number: 3, year: 2025, region: "US", start: "2025-09-01", end: "2025-12-01" },
      { battlenetId: 68, number: 3, year: 2026, region: "US", start: "2026-09-01", end: null },
      { battlenetId: 68, number: 3, year: 2026, region: "EU", start: "2026-08-31", end: null },
    ] };
    expect(seasons.cachedWindows()).toEqual([
      { number: 68, start: new Date("2026-08-31"), end: new Date("2026-10-25") },
      { number: 65, start: new Date("2025-09-01"), end: new Date("2025-12-01") },
    ]);
    expect(seasons.fetchImpl).not.toHaveBeenCalled();
  });
});
