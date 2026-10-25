"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { ChatStatsService } = require("../src/services/chatStats");
const { SeasonsService } = require("../src/services/seasons");
const { ChatbotService } = require("../src/services/chatbot");

/** @param {import('mongodb').Db} db @param {number} now */
function statsFixture(db, now) {
  const fetchImpl = jest.fn(async () => { throw new Error("No chat upstream requests"); });
  const seasons = new SeasonsService({ now: () => now, fetchImpl });
  seasons._cache = { fetchedAt: now, items: [{ battlenetId: 70, region: "US", start: "2026-10-01", end: "2026-12-01", year: 2026, number: 4 }] };
  const service = new ChatStatsService({ games: db.collection("games"), opponents: db.collection("opponents") }, { now: () => now, seasons });
  return { service, fetchImpl };
}

describe("recorded chat stats owner and visibility contract", () => {
  /** @type {MongoMemoryServer} */ let mongo;
  /** @type {MongoClient} */ let client;
  /** @type {import('mongodb').Db} */ let db;
  const now = Date.parse("2026-10-25T12:00Z");
  const game = (/** @type {Record<string,any>} */ fields = {}) => ({ userId: "owner", date: new Date("2026-10-25T10:00Z"), result: "Victory", myRace: "Protoss", myMmr: 4000,
    myToonHandle: "1-S2-1-42", map: "Map", playerCount: 2, opponent: { displayName: "<b>Enemy</b>", race: "Zerg", pulseId: "enemy" }, ...fields });
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); db = client.db("chat_stats_test"); });
  afterAll(async () => { await client?.close(); await mongo?.stop(); });
  beforeEach(async () => { await db.collection("games").deleteMany({}); await db.collection("opponents").deleteMany({}); });
  const fixture = () => statsFixture(db, now);
  test("excludes other owners, excluded/hidden/deleted/pending/resumed/future/team rows and never refreshes upstream catalogs", async () => {
    await db.collection("games").insertMany([game(), game({ userId: "another" }), game({ excluded: true }), game({ _deleted: true }), game({ _deletionPending: true }),
      game({ isResumedFromReplay: true }), game({ date: new Date(now + 1000) }), game({ playerCount: 4 })]);
    const { service, fetchImpl } = fixture(); const stats = await service.snapshot("owner");
    expect(stats.record).toBe("Today (UTC): 1W-0L | PvZ 1W-0L");
    expect(stats.winrates.pvz).toContain("100% (1W-0L; n=1)"); expect(stats.lastgame).toContain("Enemy"); expect(stats.lastgame).not.toContain("<b>");
    expect(stats.peak).toContain("4000 MMR (n=1 rated games)"); expect(fetchImpl).not.toHaveBeenCalled();
  });
  test("same owner requests coalesce and a revision prevents late results from repopulating invalidated cache", async () => {
    await db.collection("games").insertOne(game()); const { service } = fixture();
    const read = jest.spyOn(service, "_read");
    await Promise.all([service.snapshot("owner"), service.snapshot("owner")]); expect(read).toHaveBeenCalledTimes(1);
    await service.snapshot("owner"); expect(read).toHaveBeenCalledTimes(1);
    service.invalidateForUser("owner");
    /** @type {(value:any)=>void} */ let release = () => {};
    read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const stale = service.snapshot("owner"); service.invalidateForUser("owner");
    const newest = await service.snapshot("owner"); release({ ...newest, record: "stale" }); await stale;
    expect((await service.snapshot("owner")).record).not.toBe("stale");
  });
  test("H2H uses exact identity, latest three eligible meetings, and cache-only totals", async () => {
    await db.collection("games").insertMany([game({ date: new Date("2026-10-25T10:00Z") }), game({ date: new Date("2026-10-24"), result: "Defeat" }),
      game({ date: new Date("2026-10-23"), result: "Tie" }), game({ date: new Date("2026-10-22") }), game({ _deleted: true }),
      game({ userId: "another" }), game({ date: new Date(now + 1000) }), game({ playerCount: 4 })]);
    await db.collection("opponents").insertOne({ userId: "owner", pulseId: "enemy", wins: 8, losses: 3 });
    const { service } = fixture();
    expect(await service.h2h("owner", { pulseId: "enemy", displayName: "Enemy" })).toBe("Enemy: 8W-3L recorded | Last 3 meetings: W 2026-10-25, L 2026-10-24, ? 2026-10-23.");
    expect(await service.h2h("owner", { displayName: "Enemy" })).toContain("no recorded opponent identity");
  });
  test("PTR does not borrow an opponent's other-region rating and cold season cache stays honest", async () => {
    const { service } = fixture();
    await db.collection("games").insertOne(game({ myToonHandle: "98-S2-1-42", opponent: { toonHandle: "1-S2-1-900", race: "Zerg" } }));
    expect((await service.snapshot("owner")).peak).toContain("no cached regional boundary");
  });
  test("actual native-shaped live profiles resolve exact H2H, including legacy numeric game ids and string counters", async () => {
    await db.collection("games").insertMany([game({ opponent: { pulseCharacterId: "42" } }), game({ date: new Date("2026-10-24"), result: "Defeat", opponent: { pulseCharacterId: 42 } })]);
    await db.collection("opponents").insertOne({ userId: "owner", pulseCharacterId: "42", wins: 5, losses: 2 });
    const { service } = fixture();
    const envelope = { phase: "match_in_progress", isReplay: false, opponent: { name: "Native enemy", race: "Zerg", profile: { pulse_character_id: 42, confidence: 1 } } };
    const chatbot = new ChatbotService(/** @type {any} */ ({}), { chatStats: service, overlayTokens: /** @type {any} */ ({ resolve: async () => ({ userId: "owner" }) }), liveGameBroker: /** @type {any} */ ({ latest: () => envelope }) });
    expect(await chatbot.commandLine("token", "h2h")).toBe("Native enemy: 5W-2L recorded | Last 2 meetings: W 2026-10-25, L 2026-10-24.");
    envelope.opponent.profile.confidence = 0.5;
    expect(await chatbot.commandLine("token", "h2h")).toContain("no recorded opponent identity");
  });
});
