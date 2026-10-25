// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { ScoutingIdentitiesService } = require("../src/services/scoutingIdentities");
const { ScoutingForecastService } = require("../src/services/scoutingForecast");
const { OverlayLiveService } = require("../src/services/overlayLive");
const { OpponentsService } = require("../src/services/opponents");
const main = { userId: "owner", pulseId: "1-S2-1-101", pulseCharacterId: "101", displayNameSample: "Main", race: "Zerg", wins: 2, losses: 1, gameCount: 3 };
const alt = { userId: "owner", pulseId: "1-S2-1-202", pulseCharacterId: "202", displayNameSample: "Alt", race: "Zerg", wins: 1, losses: 2, gameCount: 3 };
let mongo, client, db, identities, forecasts, live, dossier, lookup;
const row = (i, other = {}) => ({ userId: "owner", gameId: `game-${i}`, date: new Date(Date.UTC(2026, 9, 25, 12) - i * 1000),
  result: i % 2 ? "Victory" : "Defeat", map: "Alcyone", myRace: "Protoss", myMmr: 4200, durationSec: 600,
  opponent: { pulseId: i < 3 ? main.pulseId : alt.pulseId, pulseCharacterId: i < 3 ? "101" : "202", displayName: i < 3 ? "Main" : "Alt", race: "Zerg", strategy: i % 2 ? "Hatch First" : "12 Pool", mmr: 6000 }, ...other });
const envelope = () => ({ type: "liveGameState", gameKey: "current-key", phase: "match_started", capturedAt: Date.now() / 1000,
  user: { name: "Owner", race: "Protoss" }, opponent: { name: "Main", race: "Zerg", toonHandle: main.pulseId, profile: { pulse_character_id: 101 } } });
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri());
  const raw = client.db("forecast_integration");
  db = Object.fromEntries(["users", "games", "opponents", "opponentNotes", "pulseCharacterLinks", "playerIdentities"].map(name => [name, raw.collection(name)]));
});
beforeEach(async () => {
  await Promise.all(Object.values(db).map(col => col.deleteMany({})));
  await db.opponents.insertMany([{ ...main }, { ...alt }]);
  await db.pulseCharacterLinks.insertMany([{ pulseCharacterId: "101", toonHandle: main.pulseId, accountId: "one" }, { pulseCharacterId: "202", toonHandle: alt.pulseId, accountId: "one" }]);
  await db.games.insertMany(Array.from({ length: 6 }, (_,i) => row(i)));
  lookup = jest.fn(async args => ({ ...args, n: 100, bandLabel: "4000–4499", openers: [{ build: "Hatch First", frequency: .6 }, { build: "12 Pool", frequency: .4 }] }));
  identities = new ScoutingIdentitiesService(db); forecasts = new ScoutingForecastService({ lookup });
  live = new OverlayLiveService(db, { scoutingIdentities: identities, scoutingForecast: forecasts });
  dossier = new OpponentsService(db, Buffer.from("disposable"), { scoutingIdentities: identities, scoutingForecast: forecasts });
});
afterAll(async () => { await client?.close(); await mongo?.stop(); });

test("live and cheap dossier share the exact merged metadata forecast with no detail/upstream hydration", async () => {
  const details = { findMany: jest.fn(() => { throw new Error("no detail expected"); }) };
  dossier.gameDetails = details;
  const payload = await live.buildFromOpponentName("owner", "Main", "Zerg", "101", "Protoss", main.pulseId);
  const profile = await dossier.get("owner", main.pulseId, { mergeLinked: true });
  expect(payload.headToHead).toEqual({ wins: 3, losses: 3 });
  expect(payload).toMatchObject({ mergedAccounts: 2, alsoPlaysAs: ["Alt"] });
  expect(payload.openingForecast.sampleSize).toBe(6);
  expect(profile.openingForecast).toEqual(payload.openingForecast);
  expect(profile.predictedStrategies).toEqual(payload.predictedStrategies.map(row => ({ strategy: row.name, probability: row.weight })));
  expect(profile).toMatchObject({ mergedAccounts: 2, alsoPlaysAs: ["Alt"] });
  expect(profile.gamesScouting).toBeUndefined(); expect(details.findMany).not.toHaveBeenCalled();
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(lookup).toHaveBeenCalledWith({ bandType: "mmr", band: 4000, matchup: "ZvP", era: "before" });
});

test("hidden, deleted, pending and other-owner samples do not affect the posterior", async () => {
  await db.games.insertMany([row(7, { excluded: true }), row(8, { _deleted: true }), row(9, { _deletionPending: true }), row(10, { userId: "other" })]);
  const payload = await live.buildFromOpponentName("owner", "Main", "Zerg", "101", "Protoss", main.pulseId);
  expect(payload.openingForecast.sampleSize).toBe(6);
  expect((await dossier.get("owner", main.pulseId, { mergeLinked: true })).openingForecast).toEqual(payload.openingForecast);
});

test("server grouping off uses only the current account and keeps notes exact-toon", async () => {
  await db.users.insertOne({ userId: "owner", preferences: { opponentScouting: { groupByPlayer: false } } });
  await db.opponentNotes.insertMany([{ userId: "owner", pulseId: main.pulseId, notes: "Current account note" }, { userId: "owner", pulseId: alt.pulseId, notes: "Never inherit this note" }]);
  const payload = await live.buildFromOpponentName("owner", "Main", "Zerg", "101", "Protoss", main.pulseId);
  expect(payload.headToHead).toEqual({ wins: 2, losses: 1 });
  expect(payload.openingForecast.sampleSize).toBe(3); expect(payload.alsoPlaysAs).toBeUndefined();
  expect(payload.opponentNotes.text).toBe("Current account note");
  const profile = await dossier.get("owner", main.pulseId, { mergeLinked: true });
  expect(profile.openingForecast.sampleSize).toBe(3); expect(profile.mergedIdentities).toBeUndefined();
});

test("bounded approved merging preserves the confirmed public identity and never warms upstream links", async () => {
  await db.pulseCharacterLinks.deleteMany({});
  await db.playerIdentities.insertOne({ active: true, groupKey: "identity:pulse:202", revision: 7,
    sourceKeys: ["pulse:101", `toon:${main.pulseId}`], targetKeys: ["pulse:202", `toon:${alt.pulseId}`],
    target: { pulseCharacterId: "202", toonHandle: alt.pulseId, displayName: "Known Player" } });
  const upstream = jest.fn(() => { throw new Error("upstream forbidden"); }); dossier.pulseLinks = { getLinks: upstream };
  const profile = await dossier.get("owner", main.pulseId, { mergeLinked: true });
  expect(profile).toMatchObject({ revealedName: "Known Player", mergedAccounts: 2, globalIdentity: { groupKey: "identity:pulse:202", revision: 7 } });
  expect(profile.openingForecast.sampleSize).toBe(6); expect(upstream).not.toHaveBeenCalled();
});

test("resolved group identity is included in enrichment cache and preference invalidation refreshes it", async () => {
  const compute = jest.spyOn(live, "buildFromOpponentName"), packet = envelope();
  const first = await live.enrichEnvelope("owner", packet);
  expect(first.streamerHistory.mergedAccounts).toBe(2);
  expect([...live._enrichmentCache.keys()][0]).toContain("acct:one");
  await live.enrichEnvelope("owner", packet);
  expect(compute).toHaveBeenCalledTimes(1);
  await db.users.insertOne({ userId: "owner", preferences: { opponentScouting: { groupByPlayer: false } } });
  live.invalidateForUser("owner");
  const next = await live.enrichEnvelope("owner", packet);
  expect(next.streamerHistory.alsoPlaysAs).toBeUndefined();
  expect(next.streamerHistory.openingForecast.sampleSize).toBe(3);
  expect([...live._enrichmentCache.keys()][0]).toContain("preference-off");
});

test("no own rating means no prior query and a true zero-personal prior-only forecast remains Low", async () => {
  await db.games.updateMany({}, { $unset: { myMmr: "" } });
  const payload = await live.buildFromOpponentName("owner", "Main", "Zerg", "101", "Protoss", main.pulseId);
  expect(payload.openingForecast.prior).toBeNull(); expect(lookup).not.toHaveBeenCalled();
  const priorOnly = await forecasts.forecast([], { myRace: "P", oppRace: "Z", myMmr: 4200 });
  expect(priorOnly).toMatchObject({ sampleSize: 0, effectiveN: 0, confidence: "Low" });
  expect(priorOnly.top[0]).toMatchObject({ name: "Hatch First", samples: 0, of: 0 });
});

test("approved-graph cache clearing fences a pending enrichment result instead of repopulating old aliases", async () => {
  let finish;
  live.buildFromOpponentName = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  const packet = envelope(), pending = live.enrichEnvelope("owner", packet);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  live.clearEnrichmentCache();
  finish({ oppName: "Main", alsoPlaysAs: ["Stale old link"] });
  expect(await pending).toBe(packet); expect(live._enrichmentCache.size).toBe(0);
});
