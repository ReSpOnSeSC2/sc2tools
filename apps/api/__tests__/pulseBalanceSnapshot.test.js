// @ts-nocheck
"use strict";

const pino = require("pino");
const request = require("supertest");
const { MongoNetworkError } = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { createBackupStore } = require("./helpers/userBackupsStore");
const { REGIONS, TIER_REQUESTS, readBalanceTier } = require("../src/services/pulseBalanceAdapter");
const { USER_AGENT, RESPONSE_MAX_BYTES, balanceSeason, buildPulseBalanceCollector } = require("../src/services/pulseBalanceCollector");
const { PulseBalanceStore } = require("../src/services/pulseBalanceStore");
const { encodeBalanceEvidence } = require("../src/services/pulseBalanceEvidence");
const { summarizeBalance } = require("../src/services/pulseBalanceSummary");
const { buildPulseBalanceSnapshotJob } = require("../src/jobs/pulseBalanceSnapshotJob");
const fixture = require("./fixtures/pulseBalance.diamond-s68.json");

const NOW = Date.parse("2026-11-13T03:00:00Z");
const DAY = "2026-11-13";
const DIAMOND = TIER_REQUESTS.find(tier => tier.league === "diamond" && tier.division === 1);
const windows = REGIONS.flatMap(region => [
  { region, battlenetId: 68, start: "2026-09-01T00:00:00Z" },
  { region, battlenetId: 69, start: region === "US" ? "2026-11-10T08:00:00Z" : "2026-11-10T00:00:00Z" },
]);

function tierFixture(tier) {
  const input = structuredClone(fixture);
  for (const league of Object.values(input.leagues)) league.type = tier.leagueId;
  for (const leagueTier of Object.values(input.tiers)) leagueTier.type = tier.tierId;
  return input;
}

function snapshot(asOf = DAY) {
  const tiers = TIER_REQUESTS.map(tier => readBalanceTier(tierFixture(tier), tier, 68));
  return { bundle: summarizeBalance({ season: 68, asOf, tiers }), tiers };
}

describe("SC2Pulse source adapter", () => {
  test("joins the real Diamond response, inverts ZvP, and includes unknown duration", () => {
    const tier = readBalanceTier(fixture, DIAMOND, 68);
    const { matchups } = summarizeBalance({ season: 68, asOf: DAY, tiers: [tier] }).tiers[0];
    expect(matchups.map(({ matchup, sameTier, crossTier }) => [
      matchup, sameTier.wins, sameTier.games, crossTier.wins, crossTier.games,
    ])).toEqual([["PvT", 237, 459, 139, 288], ["PvZ", 272, 626, 159, 310], ["TvZ", 355, 649, 164, 325]]);
    expect(tier.rows.some(row => row.duration === 0)).toBe(true);
    expect(new Set(tier.bounds.map(row => row.region))).toEqual(new Set(REGIONS));
  });

  test("keeps distinct source maps with a shared label", () => {
    const input = structuredClone(fixture);
    const [id, map] = Object.entries(input.maps)[0];
    const film = Object.values(input.films).find(row => row.mapId === Number(id));
    const frame = input.frames.find(row => row.mapStatsFilmId === film.id);
    input.maps[900001] = { ...map, id: 900001 };
    input.films[900002] = { ...film, id: 900002, mapId: 900001 };
    input.frames.push({ ...frame, mapStatsFilmId: 900002 });
    const rows = readBalanceTier(input, DIAMOND, 68).rows;
    expect(rows.filter(row => row.map === map.name).map(row => row.mapId)).toEqual(expect.arrayContaining([Number(id), 900001]));
  });

  test.each([
    ["duplicate frame", input => input.frames.push(input.frames[0])],
    ["missing film frames", input => { input.frames = input.frames.filter(row => row.mapStatsFilmId !== input.frames[0].mapStatsFilmId); }],
    ["zero games", input => { input.frames[0].games = 0; }],
    ["unrecognized region", input => { Object.values(input.seasons)[0].region = "CN"; }],
    ["wrong league", input => { Object.values(input.leagues)[0].type = 6; }],
    ["empty response", input => { input.films = {}; input.frames = []; }],
  ])("rejects %s", (_label, alter) => {
    const input = structuredClone(fixture);
    alter(input);
    expect(() => readBalanceTier(input, DIAMOND, 68)).toThrow("Invalid SC2Pulse balance");
  });
});

describe("nightly SC2Pulse collection", () => {
  test("uses the preceding global season until every region clears warmup", () => {
    expect(balanceSeason(windows, NOW)).toBe(68);
    expect(balanceSeason(windows, Date.parse("2026-11-18T07:59:59Z"))).toBe(68);
    expect(balanceSeason(windows, Date.parse("2026-11-18T08:00:00Z"))).toBe(69);
    expect(balanceSeason(windows.filter(item => item.region !== "US"), NOW)).toBeNull();
  });

  test("makes exactly 19 serial requests with spacing and source attribution", async () => {
    const catalog = jest.fn(async () => ({ items: windows, fetchedAt: NOW }));
    const trace = [];
    const wait = jest.fn(async () => { trace.push("wait"); });
    let index = 0;
    const fetchImpl = jest.fn(async () => {
      trace.push("fetch");
      return Response.json(tierFixture(TIER_REQUESTS[index++]));
    });
    const collect = buildPulseBalanceCollector({ catalog, now: () => NOW, wait, fetchImpl });
    const { bundle, tiers } = await collect(DAY, new AbortController().signal);
    expect(bundle).toEqual(expect.objectContaining({ asOf: DAY, season: 68 }));
    expect(bundle.tiers).toHaveLength(19);
    expect(tiers).toHaveLength(19);
    expect(trace).toEqual(Array.from({ length: 19 }, () => ["wait", "fetch"]).flat());
    expect(new Set(wait.mock.calls.map(([ms]) => ms))).toEqual(new Set([2000]));
    expect(catalog).toHaveBeenCalledTimes(1);
    for (const [i, [url, init]] of fetchImpl.mock.calls.entries()) {
      const tier = TIER_REQUESTS[i];
      expect(url.pathname).toBe("/sc2/api/stats/balance-reports");
      expect(url.searchParams.get("season")).toBe("68");
      expect(url.searchParams.get("league")).toBe(tier.league.toUpperCase());
      expect(url.searchParams.get("tier")).toBe(tier.tier);
      expect(url.searchParams.getAll("region")).toEqual(REGIONS);
      expect(url.searchParams.getAll("race")).toEqual(["PROTOSS", "TERRAN", "ZERG"]);
      expect(url.searchParams.has("crossTier")).toBe(false);
      expect(url.searchParams.has("frameNumberMax")).toBe(false);
      expect(init.headers["user-agent"]).toBe(USER_AGENT);
      expect(init.redirect).toBe("error");
    }
  });

  test("abandons an incomplete batch without retrying and reports the tier", async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(Response.json(tierFixture(TIER_REQUESTS[0])))
      .mockResolvedValueOnce(new Response("{}", { headers: { "Content-Length": String(RESPONSE_MAX_BYTES + 1) } }));
    const collect = buildPulseBalanceCollector({
      catalog: async () => ({ items: windows, fetchedAt: NOW - 60_000 }),
      now: () => NOW, wait: async () => {}, fetchImpl,
    });
    await expect(collect(DAY, new AbortController().signal)).rejects.toMatchObject({
      code: "pulse_balance_http_error", league: "bronze", division: 2,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("publishing and serving balance snapshots", () => {
  test("retries a transient publication failure with the same complete day", async () => {
    const current = {
      findOne: jest.fn().mockResolvedValue(null),
      replaceOne: jest.fn().mockRejectedValueOnce(new MongoNetworkError("write interrupted")).mockResolvedValue({}),
    };
    const daily = { updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }) };
    const store = new PulseBalanceStore({ current, daily });
    const value = snapshot();
    await expect(store.publish(value)).resolves.toBe(true);
    expect(daily.updateOne).toHaveBeenCalledTimes(2);
    expect(daily.updateOne.mock.calls[0]).toEqual(daily.updateOne.mock.calls[1]);
    expect(current.replaceOne.mock.calls[0]).toEqual(current.replaceOne.mock.calls[1]);
    const packed = current.replaceOne.mock.calls[1][1];
    expect(packed).toMatchObject({ _id: 68, _schemaVersion: 1, bundle: value.bundle });
    expect(packed.tiers[0].maps[0]).toHaveLength(2);
    expect(packed.tiers[0].rows[0]).toHaveLength(7);
    expect(daily.updateOne.mock.calls[0][1].$set.tiers[0].rows[0]).toHaveLength(5);
  });

  test("reads current evidence using only the compact Mongo projection", async () => {
    const payload = { season: 68, asOf: DAY, maps: [], tiers: [] };
    const current = { findOne: jest.fn().mockResolvedValue({ _id: 68, asOf: DAY, evidence: encodeBalanceEvidence(payload) }) };
    const store = new PulseBalanceStore({ current });
    await expect(store.evidence()).resolves.toEqual(payload);
    await expect(store.evidence({ season: 68, asOf: DAY })).resolves.toEqual(payload);
    expect(current.findOne.mock.calls).toEqual([
      [{}, { sort: { _id: -1 }, projection: { asOf: 1, evidence: 1, _schemaVersion: 1 } }],
      [{ _id: 68, asOf: DAY }, { sort: { _id: -1 }, projection: { asOf: 1, evidence: 1, _schemaVersion: 1 } }],
    ]);
  });

  test("resolves the exact old archive if legacy current changes between reads", async () => {
    const prior = { season: 68, asOf: "2026-11-12", maps: [], tiers: [] };
    const current = { findOne: jest.fn().mockResolvedValueOnce({ _id: prior.season, asOf: prior.asOf }).mockResolvedValueOnce(null) };
    const archive = { findOne: jest.fn().mockResolvedValue({ evidence: encodeBalanceEvidence(prior) }) };
    const store = new PulseBalanceStore({ current, archive });
    await expect(store.evidence()).resolves.toEqual(prior);
    expect(current.findOne.mock.calls[1][0]).toEqual({ _id: prior.season, asOf: prior.asOf });
    expect(archive.findOne).toHaveBeenCalledWith({ _id: "68/2026-11-12" });
  });

  test("serves only a complete persisted bundle through the public application route", async () => {
    const mongo = await MongoMemoryServer.create();
    let db;
    try {
      db = await connect({ uri: mongo.getUri(), dbName: "sc2tools_test_pulse_balance" });
      const { app, services } = buildApp({
        db, logger: pino({ level: "silent" }), userBackupsStore: createBackupStore(),
        config: {
          nodeEnv: "test", clerkSecretKey: "sk_test", serverPepper: Buffer.alloc(32, 7),
          corsAllowedOrigins: [], rateLimitPerMinute: 100, adminUserIds: [],
        },
      });
      const { pulseBalance } = services;
      const oldDay = "2026-11-12";
      const old = snapshot(oldDay);
      const today = snapshot();
      const response = () => request(app).get("/v1/ladder/balance");
      const evidence = () => request(app).get("/v1/ladder/balance/evidence");
      await response().expect(503).expect("Cache-Control", "no-store")
        .expect({ error: { code: "balance_snapshot_unavailable" } });
      await evidence().expect(503).expect("Cache-Control", "no-store");
      await evidence().query({ season: 68 }).expect(400).expect("Cache-Control", "no-store");
      await evidence().query({ season: 68, asOf: "2026-02-30" }).expect(400);
      expect(await Promise.all([pulseBalance.claim(oldDay, NOW), pulseBalance.claim(oldDay, NOW)]))
        .toEqual(expect.arrayContaining([true, false]));
      await pulseBalance.publish(old);
      const oldPin = { season: 68, asOf: oldDay };
      const oldEvidence = (await evidence().query(oldPin).expect(200)).body;
      expect(oldEvidence).toEqual((await evidence().expect(200)).body);
      const diamond = oldEvidence.tiers.find(tier => tier.league === "diamond" && tier.division === 1);
      expect(diamond.matchups[1]).toEqual({ matchup: "PvZ", wins: 272, games: 626 });
      const cells = diamond.mapMatchups.filter(cell => cell.matchup === "PvZ");
      expect(cells.reduce((sum, cell) => sum + cell.games, 0)).toBe(626);
      expect(cells.reduce((sum, cell) => sum + cell.wins, 0)).toBe(272);
      expect(diamond.bounds.map(bound => bound.region).sort()).toEqual([...REGIONS].sort());
      // A B1 worker wrote the same shape minus the compact evidence projection.
      await db.pulseBalanceCurrent.updateOne({ _id: 68 }, { $unset: { evidence: "" } });
      await evidence().query(oldPin).expect(200).expect(oldEvidence);
      await pulseBalance.claim(DAY, NOW);
      await expect(pulseBalance.publish({ ...today, tiers: today.tiers.slice(1) })).rejects.toThrow("tier coverage");
      await response().expect(200).expect(old.bundle);
      await evidence().query({ season: 68, asOf: DAY }).expect(404).expect("Cache-Control", "no-store");
      await pulseBalance.publish(today);
      expect((await db.pulseBalanceCurrent.findOne({ _id: 68 })).evidence).toBeDefined();
      await expect(pulseBalance.publish(old)).resolves.toBe(false);
      await response().expect(200).expect("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400").expect(today.bundle);
      await evidence().query(oldPin).expect(200).expect("Cache-Control", "public, max-age=31536000, immutable").expect(oldEvidence);
      await evidence().query({ ...oldPin, season: 67 }).expect(404);
      expect(await db.pulseBalanceArchive.countDocuments()).toBe(1);
      const daily = await db.pulseBalanceDaily.findOne({ _id: DAY });
      expect(daily).toMatchObject({ season: 68, _schemaVersion: 1 });
      expect(daily.tiers).toHaveLength(19);
      expect(daily.tiers[0].rows[0]).toHaveLength(5);
      expect(await db.pulseBalanceCurrent.countDocuments()).toBe(1);
    } finally {
      await db?.close();
      await mongo.stop();
    }
  });
});

describe("nightly balance worker", () => {
  test("claims the UTC day once and leaves the previous bundle on source failure", async () => {
    const prior = { asOf: "2026-11-12", season: 68 };
    const store = { latest: jest.fn().mockResolvedValue(prior), claim: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false), publish: jest.fn() };
    const lock = { ensureIndexes: jest.fn(), acquire: jest.fn().mockResolvedValue("owner"), extend: jest.fn(), release: jest.fn().mockResolvedValue() };
    const collect = jest.fn().mockRejectedValue(Object.assign(new Error("upstream"), { code: "pulse_balance_invalid_source", league: "bronze", division: 1 }));
    const warn = jest.fn();
    const job = buildPulseBalanceSnapshotJob({
      enabled: true, store, lock, collect, now: () => NOW, logger: { child: () => ({ warn }) },
    });
    job.start();
    await new Promise(resolve => setImmediate(resolve));
    await job.stop();
    job.start();
    await new Promise(resolve => setImmediate(resolve));
    await job.stop();
    expect(store.claim.mock.calls).toEqual([[DAY, NOW], [DAY, NOW]]);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(store.publish).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ code: "pulse_balance_invalid_source", league: "bronze", division: 1 }), "pulse_balance_snapshot_failed");
  });
});
