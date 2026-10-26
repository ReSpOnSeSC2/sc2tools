// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { ScoutingIdentitiesService, TTL_MS } = require("../src/services/scoutingIdentities");
let mongo, client, db, service, clock;
const primary = { userId: "owner", pulseId: "1-S2-1-101", pulseCharacterId: "101", displayNameSample: "Main", wins: 2, losses: 1, gameCount: 3 };
const alt = { userId: "owner", pulseId: "1-S2-1-202", pulseCharacterId: "202", displayNameSample: "Alt", wins: 1, losses: 2, gameCount: 3 };
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri());
  const raw = client.db("scouting_identities");
  db = Object.fromEntries(["users", "opponents", "pulseCharacterLinks", "playerIdentities"].map(name => [name, raw.collection(name)]));
  await db.opponents.createIndex({ userId: 1, pulseCharacterId: 1 });
  await db.pulseCharacterLinks.createIndex({ accountId: 1 });
  await db.playerIdentities.createIndex({ targetKeys: 1, active: 1 });
});
beforeEach(async () => {
  await Promise.all(Object.values(db).map(col => col.deleteMany({})));
  await db.opponents.insertMany([{ ...primary }, { ...alt }, { ...alt, userId: "other", wins: 999, displayNameSample: "Private other" }]);
  clock = 100; service = new ScoutingIdentitiesService(db, { now: () => clock });
});
afterAll(async () => { await client?.close(); await mongo?.stop(); });
const cachedAccounts = () => db.pulseCharacterLinks.insertMany([{ pulseCharacterId: "101", toonHandle: primary.pulseId, accountId: "account-one" }, { pulseCharacterId: "202", toonHandle: alt.pulseId, accountId: "account-one" }]);

test("cached accountId merges only this owner's rows, sums H2H and exposes bounded observed aliases", async () => {
  await cachedAccounts();
  const result = await service.resolve("owner", primary);
  expect(result).toMatchObject({ groupKey: "acct:account-one", mergedAccounts: 2, wins: 3, losses: 3, gameCount: 6, alsoPlaysAs: ["Alt"] });
  expect(result.pulseIds).toEqual([primary.pulseId, alt.pulseId]);
  expect(JSON.stringify(result)).not.toContain("Private other");
  expect(service.cacheKey("owner", "101", primary.pulseId)).toContain("acct:account-one");
  expect(service.cacheKey("other", "101", primary.pulseId)).toBe("unresolved");
});

test("approved target-key graph joins distinct accounts without upstream or a full owner enumeration", async () => {
  await db.playerIdentities.insertMany([
    { active: true, groupKey: "identity:pulse:303", sourceKeys: ["pulse:101", `toon:${primary.pulseId}`], targetKeys: ["pulse:303"] },
    { active: true, groupKey: "identity:pulse:303", sourceKeys: ["pulse:202", `toon:${alt.pulseId}`], targetKeys: ["pulse:303"] },
    { active: false, groupKey: "other", sourceKeys: ["pulse:999"], targetKeys: ["pulse:303"] },
  ]);
  const find = jest.spyOn(db.opponents, "find");
  const result = await service.resolve("owner", primary);
  expect(result.mergedAccounts).toBe(2);
  expect(result.alsoPlaysAs).toEqual(["Alt"]);
  expect(find).toHaveBeenCalledTimes(1);
  const [match, opts] = find.mock.calls[0];
  expect(match.userId).toBe("owner");
  expect(match.$or[0].pulseCharacterId.$in).toEqual(expect.arrayContaining(["101", "202", "303"]));
  expect(opts.maxTimeMS).toBe(1000);
  expect(JSON.stringify(opts.projection)).not.toMatch(/notes|detail|buildLog|events/);
  find.mockRestore();
});

test("server preference off and explicit single-account scope do no identity or sibling reads", async () => {
  await cachedAccounts(); await db.users.insertOne({ userId: "owner", preferences: { opponentScouting: { groupByPlayer: false } } });
  const find = jest.spyOn(db.pulseCharacterLinks, "find"), approved = jest.spyOn(db.playerIdentities, "find");
  expect((await service.resolve("owner", primary)).mergedAccounts).toBe(1);
  expect((await service.resolve("owner", primary, false)).mergedAccounts).toBe(1);
  expect(find).not.toHaveBeenCalled(); expect(approved).not.toHaveBeenCalled();
  find.mockRestore(); approved.mockRestore();
});

test("same display name or an unapproved Pulse proId never links separate accounts", async () => {
  await db.pulseCharacterLinks.insertMany([{ pulseCharacterId: "101", accountId: "one", proId: "shared" }, { pulseCharacterId: "202", accountId: "two", proId: "shared" }]);
  expect((await service.resolve("owner", primary)).mergedAccounts).toBe(1);
});

test("contradictory exact toon/CID cache evidence and conflicting approvals fail closed", async () => {
  await db.pulseCharacterLinks.insertOne({ pulseCharacterId: "101", toonHandle: "1-S2-1-999", accountId: "one" });
  expect((await service.resolve("owner", primary)).mergedAccounts).toBe(1);
  await db.pulseCharacterLinks.deleteMany({}); service.invalidateForUser("owner");
  await db.playerIdentities.insertMany([{ active: true, groupKey: "one", sourceKeys: ["pulse:101"], targetKeys: ["pulse:202"] }, { active: true, groupKey: "two", sourceKeys: ["pulse:101"], targetKeys: ["pulse:303"] }]);
  expect((await service.resolve("owner", primary)).mergedAccounts).toBe(1);
});

test("catalog expansion is bounded at20 owned accounts and always includes the current one", async () => {
  await cachedAccounts();
  const rows = Array.from({ length: 35 }, (_,i) => ({ pulseCharacterId: String(300 + i), accountId: "account-one" }));
  await db.pulseCharacterLinks.insertMany(rows);
  await db.opponents.insertMany(rows.map(row => ({ userId: "owner", ...row, pulseId: `1-S2-1-${row.pulseCharacterId}`, displayNameSample: `Alt${row.pulseCharacterId}`, wins: 1, gameCount: 1 })));
  const result = await service.resolve("owner", primary);
  expect(result.identities).toHaveLength(20); expect(result.pulseIds).toHaveLength(20);
  expect(result.identities[0].pulseId).toBe(primary.pulseId);
  expect(result.alsoPlaysAs.length).toBeLessThanOrEqual(19);
});

test("cache expiry and owner invalidation refresh membership without retaining late writes", async () => {
  await cachedAccounts();
  expect((await service.resolve("owner", primary)).mergedAccounts).toBe(2);
  await db.pulseCharacterLinks.updateOne({ pulseCharacterId: "202" }, { $set: { accountId: "other" } });
  expect((await service.resolve("owner", primary)).mergedAccounts).toBe(2);
  clock += TTL_MS + 1;
  expect(service.cacheKey("owner", "101", primary.pulseId)).toBe("unresolved");
  expect((await service.resolve("owner", primary)).mergedAccounts).toBe(1);
  let finish;
  service.invalidateForUser("owner");
  service.load = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  const pending = service.resolve("owner", primary);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  service.invalidateForUser("owner");
  finish({ mergedAccounts: 99, groupKey: "stale" });
  expect((await pending).mergedAccounts).toBe(1); expect(service.cache.size).toBe(0);
});
