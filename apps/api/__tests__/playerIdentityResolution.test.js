// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { PlayerIdentitiesService } = require("../src/services/playerIdentities");

const SOURCE = "1-S2-1-11111";
const TARGET = "2-S2-1-22222";
const ALT = "1-S2-1-33333";
const OTHER = "1-S2-1-44444";

describe("Exact global identity resolution", () => {
  let mongo;
  let db;
  let service;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "player_identity_resolution_test" });
    service = new PlayerIdentitiesService(db);
  });
  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });
  beforeEach(async () => {
    await db.playerIdentities.deleteMany({});
    await db.pulseCharacterLinks.deleteMany({});
    await db.pulseAccounts.deleteMany({});
    await db.playerIdentities.insertOne({
      kind: "link", active: true, sourceKeys: [`toon:${SOURCE}`],
      targetKeys: [`toon:${TARGET}`, "pulse:222", "acct:900", "pro:42"],
      groupKey: "pro:42", revision: 1,
      target: { key: `toon:${TARGET}`, toonHandle: TARGET, pulseCharacterId: "222", displayName: "KnownPlayer" },
    });
    await db.pulseCharacterLinks.insertMany([
      { pulseCharacterId: "222", toonHandle: TARGET, accountId: "900", proId: "42" },
      { pulseCharacterId: "333", toonHandle: ALT, accountId: "900", proId: null },
    ]);
  });

  test("resolves target-side cached account aliases and numeric character inputs", async () => {
    const resolved = await service.resolveMany([
      { toonHandle: SOURCE }, { toonHandle: TARGET }, { toonHandle: ALT },
      { pulseCharacterId: 222 }, { pulseCharacterId: "333" }, { toonHandle: TARGET, pulseCharacterId: 222 },
    ]);
    expect(resolved).toHaveLength(6);
    expect(resolved.every((row) => row?.groupKey === "pro:42" && row.displayName === "KnownPlayer")).toBe(true);
  });

  test("rejects conflicting CID/toon evidence even when only the Pulse linkage cache knows the pairing", async () => {
    expect(await db.pulseAccounts.countDocuments({})).toBe(0);
    expect(await service.resolveMany([
      { toonHandle: SOURCE, pulseCharacterId: "222" },
      { toonHandle: TARGET, pulseCharacterId: "333" },
      { pulseId: SOURCE, toonHandle: TARGET, pulseCharacterId: "222" },
    ])).toEqual([null, null, null]);
  });

  test("conflicting shared caches fail closed instead of assigning either cached player", async () => {
    await db.pulseAccounts.insertOne({ toonHandle: TARGET, pulseCharacterId: "333" });
    expect(await service.resolveMany([{ toonHandle: TARGET }, { toonHandle: TARGET, pulseCharacterId: "222" }, { toonHandle: SOURCE }])).toEqual([null, null, null]);
  });

  test("one exact source approval does not assert other source-side account characters or matching names", async () => {
    await db.pulseCharacterLinks.insertMany([
      { pulseCharacterId: "111", toonHandle: SOURCE, accountId: "100", proId: null },
      { pulseCharacterId: "444", toonHandle: OTHER, accountId: "100", proId: null },
    ]);
    const resolved = await service.resolveMany([
      { toonHandle: SOURCE }, { toonHandle: OTHER }, { displayName: "KnownPlayer" },
    ]);
    expect(resolved[0].groupKey).toBe("pro:42");
    expect(resolved.slice(1)).toEqual([null, null]);
  });

  test("conflicting target groups fail closed while exact approved source overrides retain priority", async () => {
    await db.pulseCharacterLinks.insertOne({ pulseCharacterId: "999", toonHandle: "1-S2-1-99999", accountId: "900", proId: "43" });
    await db.playerIdentities.insertOne({
      kind: "link", active: true, sourceKeys: [`toon:${OTHER}`], targetKeys: ["pulse:999", "acct:900", "pro:43"],
      groupKey: "identity:conflict", revision: 1,
      target: { key: "pulse:999", pulseCharacterId: "999", displayName: "DifferentPlayer" },
    });
    const resolved = await service.resolveMany([{ toonHandle: TARGET }, { toonHandle: SOURCE }, { toonHandle: OTHER }]);
    expect(resolved[0]).toBeNull();
    expect(resolved[1].groupKey).toBe("pro:42");
    expect(resolved[2].groupKey).toBe("pro:43");
  });

  test("a locally approved target adopts later verified Pulse aliases without rewriting its stored edge", async () => {
    await db.pulseCharacterLinks.deleteMany({});
    await db.playerIdentities.updateOne({ kind: "link" }, { $set: {
      target: { key: `toon:${TARGET}`, toonHandle: TARGET, displayName: "KnownPlayer" },
      targetKeys: [`toon:${TARGET}`], groupKey: `identity:toon:${TARGET}`,
    } });
    const storedBefore = await db.playerIdentities.findOne({ kind: "link" });
    expect((await service.resolveMany([{ toonHandle: SOURCE }]))[0].groupKey).toBe(`identity:toon:${TARGET}`);
    await db.pulseAccounts.insertOne({ toonHandle: TARGET, pulseCharacterId: "222" });
    await db.pulseCharacterLinks.insertMany([
      { pulseCharacterId: "222", accountId: "900", proId: "42" },
      { pulseCharacterId: "333", toonHandle: ALT, accountId: "901", proId: "42" },
    ]);
    const resolved = await service.resolveMany([{ toonHandle: SOURCE }, { toonHandle: TARGET }, { toonHandle: ALT }]);
    expect(resolved.every((row) => row?.groupKey === "pro:42" && row.displayName === "KnownPlayer")).toBe(true);
    expect(await db.playerIdentities.findOne({ kind: "link" })).toEqual(storedBefore);
  });

  test("large batches preserve order and every approved result", async () => {
    const inputs = Array.from({ length: 2500 }, (_, index) => index % 2
      ? { toonHandle: ALT } : { toonHandle: SOURCE });
    inputs[1337] = { toonHandle: OTHER };
    const resolved = await service.resolveMany(inputs);
    expect(resolved).toHaveLength(inputs.length);
    expect(resolved[1337]).toBeNull();
    expect(resolved.filter(Boolean)).toHaveLength(2499);
  });
});
