// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");
const { PlayerIdentitiesService } = require("../src/services/playerIdentities");
const { PulseDirectoryService } = require("../src/services/pulseDirectory");

const SOURCE = "2-S2-2-240434";
const TARGET = "2-S2-2-632713";
const SOURCE_CID = "8703807";
const TARGET_CID = "236671";
const SOURCE_RACES = [{ race: "Random", mmr: 5275, games: 25, league: "Master", region: "EU" }];
const TARGET_RACES = [{ race: "Protoss", mmr: 6100, games: 80, league: "Grandmaster", region: "EU" }];

describe("Confirmed player current ladder identity", () => {
  let mongo;
  let db;
  let directory;
  let pulseMmr;
  let opponents;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "confirmed_ladder_test" });
  });
  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });
  beforeEach(async () => {
    for (const collection of [db.opponents, db.games, db.playerIdentities, db.pulseAccounts, db.pulseCharacterLinks]) await collection.deleteMany({});
    await db.opponents.insertOne({
      userId: "u1", pulseId: SOURCE, pulseCharacterId: SOURCE_CID, toonHandle: SOURCE,
      displayNameSample: "IIlIIlIl", race: "P", mmr: 5275, region: "EU",
      gameCount: 1, wins: 1, losses: 0, lastSeen: new Date("2026-01-01T00:00:00Z"),
    });
    await db.games.insertOne({
      userId: "u1", gameId: "replay-vs-barcode", date: new Date("2026-01-01T00:00:00Z"),
      myRace: "Protoss", result: "Victory", durationSec: 600, map: "Goldenaura",
      opponent: { pulseId: SOURCE, pulseCharacterId: SOURCE_CID, toonHandle: SOURCE, displayName: "IIlIIlIl", race: "Protoss", mmr: 5190 },
    });
    await db.playerIdentities.insertOne({
      kind: "link", active: true, sourceKeys: [`toon:${SOURCE}`, `pulse:${SOURCE_CID}`],
      targetKeys: [`toon:${TARGET}`, `pulse:${TARGET_CID}`], groupKey: `identity:toon:${TARGET}`, revision: 1,
      target: { key: `toon:${TARGET}`, toonHandle: TARGET, pulseCharacterId: TARGET_CID, displayName: "Strange", region: "EU" },
    });
    directory = new PulseDirectoryService(db);
    await directory.recordMmr({ toonHandle: SOURCE, pulseCharacterId: SOURCE_CID, mmr: 5275, region: "EU", races: SOURCE_RACES });
    pulseMmr = { getRaceBreakdown: jest.fn(async () => TARGET_RACES) };
    opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      playerIdentities: new PlayerIdentitiesService(db), pulseMmr, pulseDirectory: directory,
    });
  });

  test("main-profile race ratings bypass the barcode cache and leave replay identities and MMR untouched", async () => {
    const result = await opponents.getPulseRaceBreakdown("u1", SOURCE);
    expect(pulseMmr.getRaceBreakdown).toHaveBeenCalledWith([TARGET_CID, TARGET], { preferredRegion: "EU" });
    expect(result).toMatchObject({
      resolved: true, races: TARGET_RACES, topMmr: 6100, topRace: "Protoss",
      ladderIdentity: { pulseCharacterId: TARGET_CID, toonHandle: TARGET, displayName: "Strange", confirmed: true },
    });
    const profile = await opponents.get("u1", SOURCE);
    expect(profile).toMatchObject({ pulseId: SOURCE, pulseCharacterId: SOURCE_CID, toonHandle: SOURCE, mmr: 5190 });
    expect((await db.games.findOne({ gameId: "replay-vs-barcode" })).opponent).toMatchObject({ pulseCharacterId: SOURCE_CID, toonHandle: SOURCE, mmr: 5190 });
    expect((await directory.getFreshMmr({ toonHandle: SOURCE })).races).toEqual(SOURCE_RACES);
    expect((await directory.getFreshMmr({ toonHandle: TARGET })).races).toEqual(TARGET_RACES);
  });

  test("current main-profile ratings are shared across users and unlinked accounts use their original ladder data", async () => {
    await opponents.getPulseRaceBreakdown("u1", SOURCE);
    await db.opponents.insertOne({ userId: "u2", pulseId: SOURCE, pulseCharacterId: SOURCE_CID, toonHandle: SOURCE });
    expect((await opponents.getPulseRaceBreakdown("u2", SOURCE)).topMmr).toBe(6100);
    expect(pulseMmr.getRaceBreakdown).toHaveBeenCalledTimes(1);
    await db.playerIdentities.updateOne({ kind: "link" }, { $set: { active: false } });
    const unlinked = await opponents.getPulseRaceBreakdown("u1", SOURCE);
    expect(unlinked).toMatchObject({ topMmr: 5275, topRace: "Random", ladderIdentity: { confirmed: false, pulseCharacterId: SOURCE_CID } });
  });

  test("missing target ratings never fall back to the barcode's current ladder rating", async () => {
    pulseMmr.getRaceBreakdown.mockResolvedValue([]);
    const result = await opponents.getPulseRaceBreakdown("u1", SOURCE);
    expect(result).toMatchObject({ resolved: false, races: [], topMmr: null, ladderIdentity: { confirmed: true, pulseCharacterId: TARGET_CID } });
  });

  test("a main profile saved before CID resolution uses its current shared exact-toon resolution", async () => {
    await db.playerIdentities.updateOne({ kind: "link" }, { $unset: { "target.pulseCharacterId": "" } });
    await directory.recordResolution({ toonHandle: TARGET, pulseCharacterId: TARGET_CID });
    expect(await opponents.resolveLadderIdentity("u1", SOURCE)).toMatchObject({ confirmed: true, pulseCharacterId: TARGET_CID, toonHandle: TARGET });
  });

  test("ownership is checked before a main profile can supply ladder data", async () => {
    expect(await opponents.resolveLadderIdentity("stranger", SOURCE)).toBeNull();
    expect(await opponents.getPulseRaceBreakdown("stranger", SOURCE)).toBeNull();
    expect(pulseMmr.getRaceBreakdown).not.toHaveBeenCalled();
  });
});
