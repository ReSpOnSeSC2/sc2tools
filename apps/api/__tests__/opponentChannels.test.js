// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { PlayerChannelsService } = require("../src/services/playerChannels");
const { OpponentChannelsCache } = require("../src/services/opponentChannels");
let mongo, db, directory, cache;
const envelope = { gameKey: "game-one", phase: "match_in_progress", opponent: { name: "A name is not a key", toonHandle: "1-S2-1-123", profile: { pulse_character_id: 12 } } };
beforeAll(async () => { mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "opponent_channels" }); });
afterAll(async () => { await db?.close(); await mongo?.stop(); });
beforeEach(async () => {
  await db.playerChannels.deleteMany({});
  directory = new PlayerChannelsService(db, { seeds: [], fetchImpl: jest.fn(() => { throw new Error("No network"); }) }); cache = new OpponentChannelsCache(directory);
  jest.spyOn(directory, "ensureSeeds").mockImplementation(() => { throw new Error("No seed writes"); });
  jest.spyOn(directory, "expandIdentities").mockImplementation(() => { throw new Error("No expansion"); });
});
test.each(["admin", "curated", "sc2pulse"])("exact %s match is cached once per game and does not fetch or seed", async source => {
  await db.playerChannels.insertOne({ id: "approved", source, identityKeys: ["pulse:12"], channels: { twitch: "https://twitch.tv/approved" } });
  const read = jest.spyOn(directory, "resolveApprovedExact");
  const results = await Promise.all(Array.from({ length: 30 }, () => cache.forMatch("owner", envelope)));
  expect(results.every(r => r.twitch === "https://www.twitch.tv/approved")).toBe(true); expect(read).toHaveBeenCalledTimes(1);
  await cache.forMatch("owner", { ...envelope, gameKey: "next" }); expect(read).toHaveBeenCalledTimes(2);
  expect(directory.fetchImpl).not.toHaveBeenCalled();
});
test("name, broader alias, pending self identity, removed rows and conflicts fail closed", async () => {
  await db.playerChannels.insertOne({ source: "self", pending: true, identityKeys: ["pulse:12"], approvedIdentityKeys: ["pulse:99"], channels: { twitch: "https://twitch.tv/wrong" }, pendingChannels: { twitch: "https://twitch.tv/pending" } });
  expect(await directory.resolveApprovedExact({ pulseCharacterId: 12 })).toEqual({});
  expect(await directory.resolveApprovedExact({ name: "A name is not a key" })).toEqual({});
  await db.playerChannels.deleteMany({});
  await db.playerChannels.insertOne({ source: "admin", removed: true, identityKeys: ["pulse:12"], channels: { twitch: "https://twitch.tv/removed" } });
  expect(await directory.resolveApprovedExact({ pulseCharacterId: 12 })).toEqual({});
  await db.playerChannels.deleteMany({});
  await db.playerChannels.insertOne({ id: "a", source: "admin", identityKeys: ["pulse:12"], channels: { twitch: "https://twitch.tv/a" } });
  await db.playerChannels.insertOne({ id: "b", source: "admin", identityKeys: ["toon:1-S2-1-123"], channels: { twitch: "https://twitch.tv/b" } });
  expect(await directory.resolveApprovedExact({ pulseCharacterId: 12, toonHandle: "1-S2-1-123" })).toEqual({});
});
test("a self entry uses only its previously approved channels, never its pending edits", async () => {
  await db.playerChannels.insertOne({ source: "self", pending: true, approvedAt: new Date(), identityKeys: ["pulse:12"], approvedIdentityKeys: ["pulse:12"], channels: { twitch: "https://twitch.tv/approved" }, pendingChannels: { twitch: "https://twitch.tv/pending" } });
  expect(await directory.resolveApprovedExact({ pulseCharacterId: 12 })).toEqual({ twitch: "https://www.twitch.tv/approved" });
});
test("a held directory read cannot repopulate the cache after a removal", async () => {
  await db.playerChannels.insertOne({ id: "approved", source: "admin", identityKeys: ["pulse:12"], channels: { twitch: "https://twitch.tv/approved" } });
  let release; const read = jest.spyOn(directory, "resolveApprovedExact").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const held = cache.forMatch("owner", envelope);
  await directory.removeAdmin("approved", "admin");
  release({ twitch: "https://www.twitch.tv/approved" }); expect(await held).toEqual({});
  expect(await cache.forMatch("owner", envelope)).toEqual({}); expect(read).toHaveBeenCalledTimes(2);
});
test("inactive, replay, keyless and malformed identity paths never query the directory", async () => {
  const read = jest.spyOn(directory, "resolveApprovedExact");
  for (const patch of [{ phase: "match_ended" }, { isReplay: true }, { gameKey: "" }, { gameKey: "x".repeat(121) }]) expect(await cache.forMatch("owner", { ...envelope, ...patch })).toEqual({});
  expect(read).not.toHaveBeenCalled(); expect(await directory.resolveApprovedExact({ pulseCharacterId: "bad" })).toEqual({});
});
test("an explicitly ambiguous Pulse profile cannot advertise a name-resolved channel", async () => {
  await db.playerChannels.insertOne({ id: "uncertain", source: "admin", identityKeys: ["pulse:12"], channels: { twitch: "https://twitch.tv/wrong" } });
  expect(await cache.forMatch("owner", { ...envelope, opponent: { profile: { pulse_character_id: 12, confidence: 0.5 } } })).toEqual({});
  expect(await cache.forMatch("owner", { ...envelope, opponent: { toonHandle: "1-S2-1-123", profile: { pulse_character_id: 12, confidence: 0.5 } } })).toEqual({});
});
