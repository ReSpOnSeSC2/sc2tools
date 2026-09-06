// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const {
  PlayerChannelsService,
  normalizeChannelUrl,
  normalizeIdentity,
} = require("../src/services/playerChannels");
const pulseSnapshot = require("../data/player-channel-pulse-seeds.json");
const curatedSnapshot = require("../data/player-channel-seeds.json");

// Exercise the production seed files against real MongoDB and its unique
// identity indexes. Only the external Pulse adapter is disabled: no invented
// player/channel records are substituted for the shipped directory.
describe("production player channel seeds", () => {
  let mongo;
  let db;
  let service;
  let fetchImpl;

  function newService() {
    return new PlayerChannelsService(db, {
      fetchImpl,
      pulseLinks: { getLinks: async () => ({ links: new Map(), partial: false }) },
    });
  }

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "player_channel_real_seeds" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.playerChannels.deleteMany({});
    fetchImpl = jest.fn(async () => { throw new Error("Seed bootstrap must not use HTTP"); });
    service = newService();
  });

  test("bootstraps every real upstream row with valid URLs and all curated overrides", async () => {
    expect(pulseSnapshot.entries).toHaveLength(1243);
    expect(curatedSnapshot.entries).toHaveLength(14);
    const curatedByProId = new Map(curatedSnapshot.entries.filter((entry) => entry.proId).map((entry) => [entry.proId, entry]));

    // A malformed shipped URL must fail this test, even though the service
    // deliberately skips malformed future upstream records at runtime.
    for (const entry of [...pulseSnapshot.entries, ...curatedSnapshot.entries]) {
      expect(entry.sources.length).toBeGreaterThan(0);
      for (const [platform, url] of Object.entries(entry.channels)) {
        expect(normalizeChannelUrl(platform, url)).toBeTruthy();
      }
      for (const id of entry.pulseCharacterIds || []) {
        expect(normalizeIdentity({ pulseCharacterId: id })).toEqual({ pulseCharacterId: id });
      }
      for (const toon of entry.toonHandles || []) {
        expect(normalizeIdentity({ toonHandle: toon })).toEqual({ toonHandle: toon });
      }
    }

    await Promise.all([service.ensureSeeds(), service.ensureSeeds()]);
    const persisted = await db.playerChannels.find({}).toArray();
    expect(persisted).toHaveLength(1245);
    const proRows = persisted.filter((row) => row.proId);
    expect(new Set(proRows.map((row) => row.proId)).size).toBe(proRows.length);
    expect(persisted.filter((row) => row.source === "curated")).toHaveLength(14);
    expect(persisted.filter((row) => !row.proId).map((row) => row.displayName).sort()).toEqual(["Calyx", "Cubano"]);
    const byProId = new Map(persisted.map((entry) => [entry.proId, entry]));

    for (const upstream of pulseSnapshot.entries) {
      const row = byProId.get(upstream.proId);
      expect(row).toBeDefined();
      const expected = { ...upstream.channels, ...curatedByProId.get(upstream.proId)?.channels };
      for (const [platform, url] of Object.entries(expected)) {
        expect(row.channels[platform]).toBe(normalizeChannelUrl(platform, url));
      }
      expect(row.identityKeys).toContain(`pro:${upstream.proId}`);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("resolves all 152 curated characters by either exact ID or toon with cold Pulse caches", async () => {
    const cases = curatedSnapshot.entries.flatMap((entry) => [
      ...entry.pulseCharacterIds.map((pulseCharacterId) => ({ entry, identity: { pulseCharacterId } })),
      ...entry.toonHandles.map((toonHandle) => ({ entry, identity: { toonHandle } })),
    ]);
    expect(cases).toHaveLength(304);
    expect(await db.pulseAccounts.countDocuments({})).toBe(0);
    expect(await db.pulseCharacterLinks.countDocuments({})).toBe(0);
    for (let start = 0; start < cases.length; start += 200) {
      const batch = cases.slice(start, start + 200);
      const result = await service.resolve(batch.map((item) => item.identity));
      expect(result.players).toHaveLength(batch.length);
      result.players.forEach((player, index) => {
        expect(player.displayName).toBe(batch[index].entry.displayName);
        expect(player.channels).toEqual(batch[index].entry.channels);
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("keeps verified creators separate, including players without a Pulse pro record", async () => {
    const identities = [
      { pulseCharacterId: "340944865", toonHandle: "1-S2-1-12581432" },
      { pulseCharacterId: "108882", toonHandle: "1-S2-1-1010182" },
      { pulseCharacterId: "108485", toonHandle: "1-S2-1-8205455" },
      { pulseCharacterId: "21864", toonHandle: "1-S2-1-596714" },
      { pulseCharacterId: "994428", toonHandle: "1-S2-1-267727" },
      { pulseCharacterId: "257695962", toonHandle: "1-S2-1-8085636" },
    ];
    const { players } = await service.resolve(identities);
    expect(players.map((player) => [player.displayName, player.channels.youtube])).toEqual([
      ["Calyx", "https://www.youtube.com/channel/UC6zSZ9cnTrN4vN4oWTGnnYA"],
      ["BerryCruncH", "https://www.youtube.com/channel/UCgYV3u-T9I_1iYXG4K-JiHA"],
      ["BerryCruncH", "https://www.youtube.com/channel/UCgYV3u-T9I_1iYXG4K-JiHA"],
      ["Heaven", "https://www.youtube.com/channel/UCkWW-NsS78I39fHgdqwi_1w"],
      ["ReSpOnSe", "https://www.youtube.com/channel/UCZS3YP1mvpqyuU5vPvHVG7g"],
      ["Cubano", "https://www.youtube.com/channel/UCvm30CZsbWyFt8CaXBiZvUA"],
    ]);
    expect(players[1].id).toBe(players[2].id);
    expect(new Set(players.map((player) => player.id)).size).toBe(5);

    const calyx = await db.playerChannels.findOne({ id: players[0].id });
    expect(calyx.proId).toBeNull();
    expect(calyx.pulseCharacterIds).toEqual(["340944865", "341105584", "341284585"]);
    expect(calyx.toonHandles).toEqual(["1-S2-1-12581432", "2-S2-1-10537315", "3-S2-1-8496074"]);
    expect(calyx.identityKeys.some((key) => key.startsWith("pro:"))).toBe(false);
    expect(await db.playerChannels.findOne({ id: players[1].id })).toMatchObject({ proId: "488" });
    expect(await db.playerChannels.findOne({ id: players[3].id })).toMatchObject({ proId: "517339" });
    expect(await db.playerChannels.findOne({ id: players[4].id })).toMatchObject({
      proId: "361",
      pulseCharacterIds: ["8970877", "9034461", "994428"],
      toonHandles: ["1-S2-1-267727", "2-S2-1-8780508", "3-S2-1-6833017"],
      channels: { twitch: "https://www.twitch.tv/responsesc2", youtube: "https://www.youtube.com/channel/UCZS3YP1mvpqyuU5vPvHVG7g" },
    });
    const cubano = await db.playerChannels.findOne({ id: players[5].id });
    expect(cubano).toMatchObject({
      proId: null,
      pulseCharacterIds: ["257695962", "341338524"],
      toonHandles: ["1-S2-1-8085636", "2-S2-1-11106114"],
      channels: { twitch: "https://www.twitch.tv/cubanosc2", youtube: "https://www.youtube.com/channel/UCvm30CZsbWyFt8CaXBiZvUA" },
    });
    expect(cubano.identityKeys.some((key) => key.startsWith("pro:"))).toBe(false);
    const unrelatedCubano = await service.resolve([{ pulseCharacterId: "341340331", toonHandle: "1-S2-1-8311231" }]);
    expect(unrelatedCubano.players[0].channels).toEqual({});

    const conflict = await service.resolve([{ pulseCharacterId: identities[0].pulseCharacterId, toonHandle: identities[1].toonHandle }]);
    expect(conflict.players[0].channels).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("resolves both replay perspectives from the real curated identities without upstream HTTP", async () => {
    const games = curatedSnapshot.entries.map((entry, index, all) => ({
      gameId: `channel-seed-smoke-${entry.proId || entry.pulseCharacterIds[0]}`,
      myToonHandle: entry.toonHandles[0],
      opponent: { pulseCharacterId: all[(index + 1) % all.length].pulseCharacterIds[0] },
    }));
    const result = await service.resolveForGames(games);
    games.forEach((game, index) => {
      const me = curatedSnapshot.entries[index];
      const opponent = curatedSnapshot.entries[(index + 1) % curatedSnapshot.entries.length];
      expect(result.channelsByGameId[game.gameId]).toEqual([
        { perspective: "me", playerName: me.displayName, channels: me.channels },
        { perspective: "opponent", playerName: opponent.displayName, channels: opponent.channels },
      ]);
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("restart and source reimport preserve a real creator's removal and another's channel edit", async () => {
    await service.ensureSeeds();
    const hupsaiya = await db.playerChannels.findOne({ proId: "414" });
    const harstem = await db.playerChannels.findOne({ proId: "17" });
    await service.removeAdmin(hupsaiya.id, "seed-smoke-admin");
    await service.saveAdmin({ ...harstem, channels: { youtube: harstem.channels.youtube } }, "seed-smoke-admin", harstem.id);

    const restarted = newService();
    await restarted.ensureSeeds();
    await restarted.importRows(pulseSnapshot.entries, "sc2pulse");
    await restarted.importRows(curatedSnapshot.entries, "curated", true);
    const hidden = await db.playerChannels.findOne({ proId: "414" });
    const edited = await db.playerChannels.findOne({ proId: "17" });
    expect(hidden).toMatchObject({ id: hupsaiya.id, source: "admin", removed: true, channels: { twitch: null, youtube: null } });
    expect(edited).toMatchObject({ id: harstem.id, source: "admin", channels: { twitch: null, youtube: harstem.channels.youtube } });
    expect(await db.playerChannels.countDocuments({})).toBe(1245);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
