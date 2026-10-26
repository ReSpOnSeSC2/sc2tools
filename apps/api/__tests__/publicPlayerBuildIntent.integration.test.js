// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { BuildsService } = require("../src/services/builds");
const { AggregationsService } = require("../src/services/aggregations");
const { CommunityService } = require("../src/services/community");
const { PublicProfileService } = require("../src/services/publicProfile");
const { PublicPlayerService } = require("../src/services/publicPlayer");
const { ReplayLibraryService } = require("../src/services/replayLibrary");
const { checkIn, slimGame, SECRET_NOTES } = require("./helpers/buildIntentReadersSeed");

const USER = "11111111-1111-4111-8111-111111111111";
const HANDLE = "detector-player-0123456789";
const DETECTED = "PvZ - Recorded Stargate Opener";
const PRIVATE_PLAN = "Private check-in label never published";
const PUBLISHED = "Deliberately published build content";

let mongo, db, builds, community, legacy, players, published;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "public_player_build_intent_test" });
  await db.users.insertOne({ userId: USER, clerkUserId: "synthetic-detector-owner", replaySharing: { enabled: false, slug: HANDLE } });
  await db.games.insertMany([0, 1, 2, 3].map(index => slimGame(USER, `recorded-${index}`, {
    myBuild: index < 3 ? DETECTED : null,
    result: index === 1 ? "Defeat" : "Victory",
  })));
  for (let index = 0; index < 4; index += 1) {
    await checkIn(db.games, USER, `recorded-${index}`, { key: "custom:private-plan", name: PRIVATE_PLAN, slug: "private-plan", source: "custom" });
  }
  await db.customBuilds.insertOne({ userId: USER, slug: "published-source", name: PUBLISHED, race: "Protoss", matchup: "PvZ",
    notes: "PRIVATE_LIBRARY_NOTES", steps: [{ supply: 14, time: "0:18", action: "Pylon" }] });
  community = new CommunityService(db, { slugSecret: Buffer.alloc(32, 7) });
  published = await community.publish(USER, "published-source", { title: PUBLISHED, authorName: "Synthetic public author" });
  builds = new BuildsService(db);
  const aggregations = new AggregationsService(db);
  legacy = new PublicProfileService(db, { community, aggregations, builds });
  players = new PublicPlayerService(db, { community, profile: legacy, aggregations, builds, replayLibrary: new ReplayLibraryService(db) });
});

afterEach(() => jest.restoreAllMocks());
afterAll(async () => { if (db) await db.close(); if (mongo) await mongo.stop(); });

test("owner build statistics still count private plans; detector view never falls back to them", async () => {
  expect(await builds.list(USER, {})).toEqual([expect.objectContaining({ name: PRIVATE_PLAN, total: 4, wins: 3, losses: 1, checkins: 4 })]);
  const aggregate = jest.spyOn(db.games, "aggregate");
  const detectorRows = await builds.list(USER, {}, { view: "detector", maxTimeMS: 3000 });
  expect(detectorRows).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: DETECTED, total: 3, wins: 2, losses: 1, checkins: 0 }),
    expect.objectContaining({ name: "Unknown", total: 1, checkins: 0 }),
  ]));
  expect(JSON.stringify(detectorRows)).not.toContain(PRIVATE_PLAN);
  expect(aggregate.mock.calls[0][1]).toEqual({ maxTimeMS: 3000 });
});

test("both public profile readers expose replay-detected signatures only", async () => {
  const publicationBefore = await community.getPublic(published.slug);
  const oldProfile = await legacy.getPublicProfile(USER);
  const newProfile = (await players.get(HANDLE)).profile;
  for (const profile of [oldProfile, newProfile]) {
    expect(profile.signatureBuilds).toEqual([{ name: DETECTED, games: 3, wins: 2, losses: 1, winRate: 2 / 3 }]);
    expect(profile.featuredBuild.title).toBe(PUBLISHED);
    for (const secret of [PRIVATE_PLAN, SECRET_NOTES, "private-plan", "PRIVATE_LIBRARY_NOTES"]) expect(JSON.stringify(profile)).not.toContain(secret);
  }
  expect(await community.getPublic(published.slug)).toEqual(publicationBefore);
  expect(publicationBefore.build).toMatchObject({ name: PUBLISHED, steps: [{ supply: 14, time: "0:18", action: "Pylon" }] });
  expect(JSON.stringify(publicationBefore)).not.toContain("PRIVATE_LIBRARY_NOTES");
});

test("profile OFF hides both readers while the intentional public build content stays public", async () => {
  const before = await community.getPublic(published.slug);
  await db.users.updateOne({ userId: USER }, { $set: { publicProfile: { enabled: false } } });
  expect(await legacy.getPublicProfile(USER)).toBeNull();
  expect(await players.get(HANDLE)).toBeNull();
  expect(await community.getPublic(published.slug)).toEqual(before);
  expect((await builds.list(USER, {}))[0].name).toBe(PRIVATE_PLAN);
});
