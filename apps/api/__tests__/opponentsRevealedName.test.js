// @ts-nocheck
"use strict";

/**
 * Integration: SC2Pulse "revealed" name capture for opponents.
 *
 * When a barcode opponent's anonymised account is later linked to a
 * known pro/main on sc2pulse.nephest.com, the /group/team member carries
 * a ``proNickname``. The reveal can land long AFTER we first resolved
 * the opponent's pulseCharacterId, so a dedicated re-check pass
 * (``backfillRevealedNames``) re-probes already-resolved rows and
 * persists any reveal it finds. This suite drives that pass against a
 * real Mongo (mongodb-memory-server) with a stubbed SC2Pulse fetch, then
 * asserts the reveal is stored and surfaced on the opponents list.
 */

const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");
const { PulseMmrService } = require("../src/services/pulseMmr");

function jsonResponse(payload) {
  return { ok: true, json: async () => payload };
}

/**
 * Stub SC2Pulse: one season per region; the revealed character
 * (4771238) returns a Terran team whose member carries proNickname
 * "THERIDDLER". An unrevealed character (994428) returns a team with no
 * proNickname.
 */
function makeFetchImpl() {
  return jest.fn(async (url) => {
    if (url.includes("/season/list/all")) {
      return jsonResponse([{ battlenetId: 60, region: "US" }]);
    }
    if (url.includes("/group/team") && url.includes("characterId=4771238")) {
      return jsonResponse([
        {
          id: 9,
          rating: 5400,
          region: "US",
          lastPlayed: "2026-06-01T10:00:00Z",
          members: [{ terranGamesPlayed: 1571, proNickname: "THERIDDLER" }],
        },
      ]);
    }
    if (url.includes("/group/team") && url.includes("characterId=994428")) {
      return jsonResponse([
        {
          id: 10,
          rating: 4800,
          region: "US",
          lastPlayed: "2026-05-01T10:00:00Z",
          members: [{ protossGamesPlayed: 300 }],
        },
      ]);
    }
    return { ok: false, json: async () => null };
  });
}

describe("opponents — SC2Pulse revealed-name capture", () => {
  let mongo;
  let db;
  let opponents;
  let fetchImpl;

  const USER = "u_reveal";

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "reveal_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.opponents.deleteMany({});
    fetchImpl = makeFetchImpl();
    opponents = new OpponentsService(db, Buffer.alloc(32, 7), {
      pulseMmr: new PulseMmrService({ fetchImpl }),
      logger: pino({ level: "silent" }),
    });
  });

  test("backfillRevealedNames stores the proNickname on a resolved row", async () => {
    await db.opponents.insertOne({
      userId: USER,
      pulseId: "1-S2-1-10324554",
      pulseCharacterId: "4771238",
      toonHandle: "1-S2-1-10324554",
      region: "NA",
      displayNameSample: "IIIIIIIIII",
      race: "T",
      gameCount: 1,
      wins: 0,
      losses: 1,
      firstSeen: new Date("2026-06-01"),
      lastSeen: new Date("2026-06-24"),
    });

    const res = await opponents.backfillRevealedNames(USER);
    expect(res.scanned).toBe(1);
    expect(res.revealed).toBe(1);
    expect(res.updated).toBe(1);

    const row = await db.opponents.findOne({ userId: USER });
    expect(row.revealedName).toBe("THERIDDLER");
    expect(row.revealedNameCheckedAt).toBeInstanceOf(Date);
  });

  test("a resolved-but-unrevealed opponent gets stamped, not revealed", async () => {
    await db.opponents.insertOne({
      userId: USER,
      pulseId: "1-S2-1-9",
      pulseCharacterId: "994428",
      toonHandle: "1-S2-1-9",
      region: "NA",
      displayNameSample: "SomePlayer",
      race: "P",
      gameCount: 2,
      wins: 1,
      losses: 1,
      firstSeen: new Date("2026-05-01"),
      lastSeen: new Date("2026-05-02"),
    });

    const res = await opponents.backfillRevealedNames(USER);
    expect(res.scanned).toBe(1);
    expect(res.revealed).toBe(0);

    const row = await db.opponents.findOne({ userId: USER });
    expect(row.revealedName).toBeUndefined();
    // Still stamped so the throttle skips it next cycle.
    expect(row.revealedNameCheckedAt).toBeInstanceOf(Date);
  });

  test("re-check is throttled: a freshly-checked row is skipped", async () => {
    await db.opponents.insertOne({
      userId: USER,
      pulseId: "1-S2-1-10324554",
      pulseCharacterId: "4771238",
      toonHandle: "1-S2-1-10324554",
      region: "NA",
      displayNameSample: "IIIIIIIIII",
      race: "T",
      gameCount: 1,
      wins: 0,
      losses: 1,
      firstSeen: new Date("2026-06-01"),
      lastSeen: new Date("2026-06-24"),
      // Already checked moments ago → inside the 24h window.
      revealedNameCheckedAt: new Date(),
    });

    const res = await opponents.backfillRevealedNames(USER);
    expect(res.scanned).toBe(0);
    // No SC2Pulse traffic for a throttled row.
    const teamCalls = fetchImpl.mock.calls.filter((c) =>
      String(c[0]).includes("/group/team"),
    ).length;
    expect(teamCalls).toBe(0);
  });

  test("force:true re-probes even a freshly-checked row", async () => {
    await db.opponents.insertOne({
      userId: USER,
      pulseId: "1-S2-1-10324554",
      pulseCharacterId: "4771238",
      toonHandle: "1-S2-1-10324554",
      region: "NA",
      displayNameSample: "IIIIIIIIII",
      race: "T",
      gameCount: 1,
      wins: 0,
      losses: 1,
      firstSeen: new Date("2026-06-01"),
      lastSeen: new Date("2026-06-24"),
      revealedNameCheckedAt: new Date(),
    });

    const res = await opponents.backfillRevealedNames(USER, { force: true });
    expect(res.scanned).toBe(1);
    expect(res.revealed).toBe(1);
    const row = await db.opponents.findOne({ userId: USER });
    expect(row.revealedName).toBe("THERIDDLER");
  });

  test("the opponents list surfaces revealedName", async () => {
    await db.opponents.insertOne({
      userId: USER,
      pulseId: "1-S2-1-10324554",
      pulseCharacterId: "4771238",
      toonHandle: "1-S2-1-10324554",
      region: "NA",
      displayNameSample: "IIIIIIIIII",
      revealedName: "THERIDDLER",
      race: "T",
      gameCount: 1,
      wins: 0,
      losses: 1,
      firstSeen: new Date("2026-06-01"),
      lastSeen: new Date("2026-06-24"),
    });

    const { items } = await opponents.list(USER);
    expect(items).toHaveLength(1);
    expect(items[0].revealedName).toBe("THERIDDLER");
  });
});
