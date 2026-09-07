// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");
const { PlayerIdentitiesService } = require("../src/services/playerIdentities");

const SOURCE = "1-S2-1-11111";
const TARGET = "2-S2-1-22222";
const TARGET_ALT = "1-S2-1-33333";
const UNRELATED = "1-S2-1-44444";
const APPROVED = {
  groupKey: "pro:42",
  displayName: "KnownPlayer",
  revision: 1,
  target: { key: `toon:${TARGET}`, toonHandle: TARGET, pulseCharacterId: "222" },
};

describe("Approved global opponent identities", () => {
  let mongo;
  let db;
  let active;
  let identities;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "global_opponent_identities_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
    await db.opponentNotes.deleteMany({});
    await db.playerIdentities.deleteMany({});
    await db.pulseCharacterLinks.deleteMany({});
    active = true;
    // Resolver contract: source, target and verified Pulse aliases
    // receive the same canonical key. Nicknames never participate.
    identities = {
      resolveMany: jest.fn(async (rows) => rows.map((row) => active
        && [SOURCE, TARGET, TARGET_ALT].includes(row.toonHandle || row.pulseId)
        ? APPROVED : null)),
    };
    await seed("u1", "source", SOURCE, null, "IIlIIlIl", 4, "Defeat");
    await seed("u1", "target", TARGET, "222", "MainAccount", 2, "Victory");
    await seed("u1", "target-alt", TARGET_ALT, "333", "AltAccount", 1, "Victory");
    // Same barcode spelling and no character ID must not be joined.
    await seed("u1", "unrelated", UNRELATED, null, "IIlIIlIl", 3, "Defeat");
    await seed("u2", "other-user-source", SOURCE, null, "IIlIIlIl", 5, "Victory");
  });

  async function seed(userId, gameId, toon, cid, name, day, result) {
    const date = new Date(`2026-01-0${day}T00:00:00Z`);
    await db.games.insertOne({
      userId, gameId, date, result, myRace: "Protoss", map: "Goldenaura", durationSec: 600,
      opponent: { pulseId: toon, toonHandle: toon, pulseCharacterId: cid, displayName: name, race: "Terran" },
    });
    await db.opponents.insertOne({
      userId, pulseId: toon, toonHandle: toon, pulseCharacterId: cid,
      displayNameSample: name, race: "T", gameCount: 1,
      wins: result === "Victory" ? 1 : 0, losses: result === "Defeat" ? 1 : 0,
      firstSeen: date, lastSeen: date,
    });
  }

  function service(pulseLinks = null) {
    return new OpponentsService(db, Buffer.alloc(32, 1), {
      playerIdentities: identities, pulseLinks,
    });
  }

  test("toon-only barcode merges exact approved identities and keeps original evidence", async () => {
    await db.opponentNotes.insertOne({ userId: "u1", pulseId: SOURCE, notes: "Private source note" });
    await db.opponentNotes.insertOne({ userId: "u2", pulseId: SOURCE, notes: "Another user's note" });
    const profile = await service().get("u1", SOURCE, { mergeLinked: true });
    expect(profile.name).toBe("IIlIIlIl");
    expect(profile.revealedName).toBe("KnownPlayer");
    expect(profile.displayNameSample).toBe("IIlIIlIl");
    expect(profile.globalIdentity).toEqual(APPROVED);
    expect(profile.totals).toMatchObject({ total: 3, wins: 2, losses: 1 });
    expect(profile.games.map((row) => row.id).sort()).toEqual(["source", "target", "target-alt"]);
    expect(profile.mergedIdentities.map((row) => row.name)).toEqual(["IIlIIlIl", "MainAccount", "AltAccount"]);
    expect(profile.notes).toBe("Private source note");
    const stored = await db.opponents.findOne({ userId: "u1", pulseId: SOURCE });
    expect(stored).toMatchObject({ displayNameSample: "IIlIIlIl", toonHandle: SOURCE, pulseCharacterId: null });
    expect(stored.globalIdentity).toBeUndefined();
    expect((await db.games.findOne({ userId: "u1", gameId: "source" })).opponent.displayName).toBe("IIlIIlIl");
  });

  test("every user sees the label even when they only faced the source account", async () => {
    const profile = await service().get("u2", SOURCE, { mergeLinked: true });
    expect(profile.name).toBe("IIlIIlIl");
    expect(profile.revealedName).toBe("KnownPlayer");
    expect(profile.displayNameSample).toBe("IIlIIlIl");
    expect(profile.games.map((row) => row.id)).toEqual(["other-user-source"]);
    expect(profile.mergedIdentities).toBeUndefined();
  });

  test("unfiltered and filtered lists expose approved metadata without renaming stored account samples", async () => {
    for (const opts of [{}, { filters: { since: new Date("2026-01-03T00:00:00Z") } }]) {
      const list = await service().list("u1", opts);
      const source = list.items.find((row) => row.pulseId === SOURCE);
      expect(source.globalIdentity).toEqual(APPROVED);
      expect(source.displayNameSample).toBe("IIlIIlIl");
      expect(list.items.find((row) => row.pulseId === UNRELATED).globalIdentity).toBeUndefined();
    }
  });

  test("merged replay pagination respects identity, owner and date boundaries", async () => {
    const svc = service();
    const first = await svc.listGames("u1", SOURCE, { mergeLinked: true, limit: 1 });
    expect(first.items.map((row) => row.id)).toEqual(["source"]);
    const second = await svc.listGames("u1", SOURCE, { mergeLinked: true, limit: 1, cursor: first.nextCursor });
    expect(second.items.map((row) => row.id)).toEqual(["target"]);
    const scoped = await svc.listGames("u1", TARGET, {
      mergeLinked: true, filters: { since: new Date("2026-01-03T00:00:00Z") },
    });
    expect(scoped.items.map((row) => row.id)).toEqual(["source"]);
  });

  test("grouping off preserves the approved label and unlink takes effect on the next read", async () => {
    const svc = service();
    const separate = await svc.get("u1", SOURCE);
    expect(separate.name).toBe("IIlIIlIl");
    expect(separate.revealedName).toBe("KnownPlayer");
    expect(separate.games.map((row) => row.id)).toEqual(["source"]);
    expect(separate.mergedIdentities).toBeUndefined();
    active = false;
    const unlinked = await svc.get("u1", SOURCE, { mergeLinked: true });
    expect(unlinked.name).toBe("IIlIIlIl");
    expect(unlinked.globalIdentity).toBeUndefined();
    expect(unlinked.revealedName).toBeNull();
    expect(unlinked.games.map((row) => row.id)).toEqual(["source"]);
  });

  test("approved grouping survives Pulse failure and resolver failure falls back to exact identity", async () => {
    const svc = service({ getLinks: async () => { throw new Error("Pulse unavailable"); } });
    expect((await svc.get("u1", SOURCE, { mergeLinked: true })).games).toHaveLength(3);
    identities.resolveMany.mockRejectedValue(new Error("Identity lookup unavailable"));
    const fallback = await svc.get("u1", SOURCE, { mergeLinked: true });
    expect(fallback.name).toBe("IIlIIlIl");
    expect(fallback.games.map((row) => row.id)).toEqual(["source"]);
  });

  test("real stored approval resolves source, target and cached Pulse aliases without remote requests", async () => {
    await db.pulseCharacterLinks.insertMany([
      { pulseCharacterId: "222", toonHandle: TARGET, accountId: "900", proId: "42" },
      { pulseCharacterId: "333", toonHandle: TARGET_ALT, accountId: "901", proId: "42" },
    ]);
    await db.playerIdentities.insertOne({
      kind: "link", active: true, source: { toonHandle: SOURCE }, sourceKeys: [`toon:${SOURCE}`],
      target: { ...APPROVED.target, displayName: APPROVED.displayName },
      targetKeys: [`toon:${TARGET}`, "pulse:222", "pro:42", "acct:900"],
      groupKey: APPROVED.groupKey, revision: 1,
    });
    const fetchImpl = jest.fn(() => { throw new Error("Unexpected external request"); });
    const realResolver = new PlayerIdentitiesService(db, { fetchImpl });
    const svc = new OpponentsService(db, Buffer.alloc(32, 1), { playerIdentities: realResolver });
    const fromSource = await svc.get("u1", SOURCE, { mergeLinked: true });
    const fromTarget = await svc.get("u1", TARGET_ALT, { mergeLinked: true });
    expect(fromSource.name).toBe("IIlIIlIl");
    expect(fromTarget.name).toBe("AltAccount");
    expect(fromSource.revealedName).toBe("KnownPlayer");
    expect(fromTarget.revealedName).toBe("KnownPlayer");
    expect(fromSource.games.map((row) => row.id).sort()).toEqual(["source", "target", "target-alt"]);
    expect(fromTarget.games.map((row) => row.id).sort()).toEqual(["source", "target", "target-alt"]);
    expect(fetchImpl).not.toHaveBeenCalled();
    await db.playerIdentities.updateOne({ kind: "link" }, { $set: { active: false }, $inc: { revision: 1 } });
    expect((await svc.get("u1", SOURCE, { mergeLinked: true })).games.map((row) => row.id)).toEqual(["source"]);
  });
});
