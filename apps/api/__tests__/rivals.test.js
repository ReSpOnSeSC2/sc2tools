// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { RivalsService, parseRivalGroups, summarizeRival } = require("../src/services/rivals");
const { RivalsPulseService, TTL_MS } = require("../src/services/rivalsPulse");
const { ratingDelta30d } = require("../src/services/pulseOpponentIntel");
const { MultichatViewersService } = require("../src/services/multichatViewers");
const now = Date.parse("2026-10-25T12:00:00Z"), day = 86400000;
const group = { key: "acct:one", pulseIds: ["a", "b"], primaryPulseId: "b" };
const game = (id, extra = {}) => ({ userId: "owner", gameId: `${id}`, date: new Date(now - id * 1000), result: "Victory", durationSec: 300, opponent: { pulseId: "a", strategy: "Zerg - 12 Pool" }, ...extra });
let mongo, client, db;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); const raw = client.db("rivals"); db = { games: raw.collection("games"), opponents: raw.collection("opponents") }; });
beforeEach(async () => { await Promise.all([db.games.deleteMany({}), db.opponents.deleteMany({})]); await db.opponents.insertMany([{ userId: "owner", pulseId: "a", pulseCharacterId: "101" }, { userId: "owner", pulseId: "b", pulseCharacterId: "202" }]); });
afterAll(async () => { await client?.close(); await mongo?.stop(); });
const service = (extra = {}) => new RivalsService(db, { users: { getPreferences: jest.fn().mockResolvedValue({ keys: [group.key] }) }, now: () => now, ...extra });

test("bounded input rejects duplicate keys, duplicate accounts, unknown fields and oversized bundles", () => {
  expect(parseRivalGroups([group])[0]).toEqual(group);
  for (const raw of [null, [group, group], [{ ...group, pulseIds: ["a", "a"] }], [{ ...group, primaryPulseId: "foreign" }], [{ ...group, surprise: true }], [{ ...group, pulseIds: Array.from({ length: 501 }, (_,i) => `p${i}`) }]]) expect(() => parseRivalGroups(raw)).toThrow();
});
test("one slim facet respects owner, global scope, all visibility markers, resumed and future exclusions", async () => {
  await db.games.insertMany([game(1), game(2), game(3, { opponent: { pulseId: "b", strategy: "Zerg - 12 Pool" } }), game(4, { map: "Elsewhere" }), game(5, { excluded: true }), game(6, { _deleted: true }), game(7, { _deletionPending: true }), game(8, { isResumedFromReplay: true }), game(9, { userId: "other" }), game(10, { date: new Date(now + day) }), game(11, { date: new Date(now - 8 * day) })]);
  const svc = service(), aggregate = jest.spyOn(db.games, "aggregate");
  const result = await svc.summary("owner", [group], { map: "AbsentMap" });
  expect(result.rivals[0].matchingGames).toBe(0);
  const all = await svc.summary("owner", [group]);
  expect(all.weekGames).toEqual({ a: 3, b: 1 });
  expect(all.rivals[0]).toMatchObject({ key: group.key, matchingGames: 5, sampleGames: 5, streak: { kind: "win", count: 5, atLeast: false } });
  expect(all.rivals[0].usualOpener).toMatchObject({ name: "Zerg - 12 Pool", samples: 5, of: 5 });
  expect(aggregate).toHaveBeenCalledTimes(2);
  const pipeline = aggregate.mock.calls[0][0];
  expect(JSON.stringify(pipeline)).not.toMatch(/buildOrder|macroBreakdown|events|timeseries/);
  await svc.summary("owner", [group]); expect(aggregate).toHaveBeenCalledTimes(2);
});
test("requires stored stars and owner membership before public metadata calls, and preserves the primary account", async () => {
  const batch = jest.fn().mockResolvedValue({ "202": { change: { delta: -12 } } });
  const resolve = jest.fn().mockResolvedValue({ players: [{ channels: { twitch: "https://www.twitch.tv/player" } }] });
  const peekPublicLive = jest.fn().mockReturnValue({ live: true, observedAt: new Date(now).toISOString() });
  const svc = service({ pulse: { batch }, channels: { resolve }, viewers: { peekPublicLive } });
  await expect(svc.summary("owner", [{ ...group, key: "other" }])).rejects.toMatchObject({ status: 400 });
  await expect(svc.summary("owner", [{ ...group, pulseIds: ["foreign"] }])).rejects.toMatchObject({ status: 400 });
  expect(batch).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
  const result = await svc.summary("owner", [group]);
  expect(batch).toHaveBeenCalledWith(["202"]); expect(resolve).toHaveBeenCalledWith([{ pulseCharacterId: "202" }], { cachedOnly: true });
  expect(result.rivals[0].pulse.change.delta).toBe(-12); expect(result.rivals[0].live[0]).toMatchObject({ platform: "twitch", url: "https://www.twitch.tv/player" });
  expect(peekPublicLive).toHaveBeenCalledWith("twitch", "player");
});
test("20-sample streak is a lower bound and ties/unknown results stop it", async () => {
  await db.games.insertMany(Array.from({ length: 27 }, (_,i) => game(i + 1)));
  const item = (await service().summary("owner", [group])).rivals[0];
  expect(item).toMatchObject({ sampleGames: 20, matchingGames: 27, streak: { count: 20, atLeast: true } });
  expect(summarizeRival([{ result: "Victory" }, { result: "win" }, { result: "Tie" }, { result: "win" }], 4).streak).toEqual({ kind: "win", count: 2, atLeast: false });
  expect(summarizeRival([{ result: "Tie" }, { result: "win" }], 2).streak).toBeNull();
});
test("recent counts cap is explicit rather than claiming an incomplete hot-rematch ranking", async () => {
  await db.games.insertMany(Array.from({ length: 2001 }, (_,i) => game(i + 1, { opponent: { pulseId: `p${i}` } })));
  const value = await service().summary("owner", []);
  expect(value.recentComplete).toBe(false); expect(Object.keys(value.weekGames)).toHaveLength(2000);
});
test("account/date/missing-result unknowns are never invented by the pure sample summarizer", () => {
  expect(summarizeRival([],0)).toEqual({ sampleGames: 0, matchingGames: 0, lastMeeting: null, streak: null, usualOpener: null });
});
test("owner invalidation fences an admitted old read and prevents its cache from returning after a hide", async () => {
  const svc = service(); let finish, started;
  const began = new Promise(resolve => { started = resolve; });
  svc.aggregate = jest.fn(() => new Promise(resolve => { finish = resolve; started(); }));
  const pending = svc.summary("owner", []);
  await began; svc.invalidateForUser("other"); expect(svc.inflight.size).toBe(1);
  svc.invalidateForUser("owner");
  finish({ generatedAt: new Date(now).toISOString(), recentComplete: true, hasAnyGames: true, weekGames: { a:99 }, rivals: {} });
  await expect(pending).rejects.toMatchObject({ code: "rivals_changed" });
  expect(svc.cache.size).toBe(0); expect(svc.inflight.size).toBe(0);
});

describe("six-hour bounded public rating batch", () => {
  test("singleflight, global two-cold admission, later warmup and exact TTL", async () => {
    let clock = now; const resolves = [];
    const getIntel = jest.fn(id => new Promise(resolve => resolves.push(() => resolve({ ratingDelta30d: { delta: Number(id) }, fetchedAt: new Date(clock).toISOString() }))));
    const svc = new RivalsPulseService({ getIntel }, () => clock);
    const first = svc.batch(["1", "2", "3"]), duplicate = svc.batch(["1"]);
    expect(getIntel).toHaveBeenCalledTimes(2); resolves.splice(0).forEach(resolve => resolve());
    expect(await first).toMatchObject({ "1": { change: { delta: 1 } }, "2": { change: { delta: 2 } }, "3": null }); await duplicate;
    expect((await svc.batch(["1"]))["1"].change.delta).toBe(1); expect(getIntel).toHaveBeenCalledTimes(2);
    clock += TTL_MS; const expired = svc.batch(["1"]); resolves.splice(0).forEach(resolve => resolve()); await expired; expect(getIntel).toHaveBeenCalledTimes(3);
  });
  test("raw history keeps exact 30-day boundary before sampling; stale, sparse and future-only history stays unknown", () => {
    const points = Array.from({ length: 500 }, (_,i) => ({ t: new Date(now - (499 - i) * day / 10).toISOString(), rating: 3500 + i }));
    expect(ratingDelta30d(points, now)).toMatchObject({ delta: 300, currentAt: new Date(now).toISOString() });
    expect(ratingDelta30d(points.slice(0,-31), now)).toBeNull();
    expect(ratingDelta30d([{ t: new Date(now - 40 * day).toISOString(), rating: 4000 }, points.at(-1)], now)).toBeNull();
    expect(ratingDelta30d([{ t: new Date(now + day).toISOString(), rating: 4000 }], now)).toBeNull();
  });
  test("public live cache is read-only, expires and does not equate an approved channel with live", () => {
    let clock = now; const fetchImpl = jest.fn();
    const svc = new MultichatViewersService({ fetchImpl, now: () => clock });
    expect(svc.peekPublicLive("twitch", "player")).toBeNull();
    svc.setCached("twitch:player", { platform: "twitch", viewers: 0, live: true }, now);
    expect(svc.peekPublicLive("twitch", "PLAYER")).toEqual({ live: true, observedAt: new Date(now).toISOString() });
    clock += 20001; expect(svc.peekPublicLive("twitch", "player")).toBeNull(); expect(fetchImpl).not.toHaveBeenCalled();
  });
});
