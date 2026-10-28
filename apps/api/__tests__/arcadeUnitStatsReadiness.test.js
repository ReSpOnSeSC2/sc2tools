// @ts-nocheck
"use strict";

const { gzipSync } = require("zlib");
const { Readable } = require("stream");
const { ArcadeService } = require("../src/services/arcade");
const { GameDetailsService } = require("../src/services/gameDetails");
const { R2DetailsStore } = require("../src/services/gameDetailsStore");

// Actual service/store/SDK commands; only the S3 transport and slim collection
// are synthetic. No provider, account write, parallel blob batch or parser.
function fixture(kind) {
  const metadata = { findOne: jest.fn(async () => null) };
  const client = { send: jest.fn(async command => {
    expect(command.constructor.name).toBe("GetObjectCommand");
    if (kind === "missing") throw Object.assign(new Error("missing"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    if (kind === "failed") throw Object.assign(new Error("provider unavailable"), { $metadata: { httpStatusCode: 503 } });
    return { ETag: '"unit-specimen"', Body: Readable.from([gzipSync(JSON.stringify({
      buildLog: ["[1:00] Marine", "[1:10] Marauder"],
      macroBreakdown: { player_stats: { me: { units_lost: 7 } }, stats_events: ["unneeded"] },
    }))]) };
  }) };
  const store = new R2DetailsStore({ client, bucket: "local-unit-specimen", gameDetailsCollection: metadata });
  const gameDetails = new GameDetailsService(store);
  const detailsRead = jest.spyOn(gameDetails, "findMany");
  const limit = jest.fn(() => ({ toArray: async () => [{ gameId: "g1" }, { gameId: "g2" }] }));
  const games = { find: jest.fn(() => ({ sort: () => ({ limit }) })) };
  return { service: new ArcadeService({ games }, { games: null, gameDetails }), store, client, metadata, detailsRead, limit };
}

test("genuine absent R2 and legacy objects produce an honest successful empty aggregate", async () => {
  const f = fixture("missing");
  expect(await f.service.unitStats("owner")).toEqual({ scannedGames: 2, builtByUnit: {}, totalUnitsLost: 0, lostGames: 0 });
  expect(f.client.send).toHaveBeenCalledTimes(2); expect(f.metadata.findOne).toHaveBeenCalledTimes(2);
  expect(f.limit).toHaveBeenCalledWith(1000);
  expect(f.store.bulkReadCapacitySnapshot()).toMatchObject({ active: 0, queued: 0 });
});
test("a real strict R2 read failure is retryable and cannot masquerade as missing history", async () => {
  const f = fixture("failed");
  await expect(f.service.unitStats("owner")).rejects.toMatchObject({ status: 503, code: "arcade_unit_stats_unavailable" });
  expect(f.client.send).toHaveBeenCalledTimes(1); expect(f.metadata.findOne).not.toHaveBeenCalled();
  expect(f.store.bulkReadCapacitySnapshot()).toMatchObject({ active: 0, queued: 0 });
});
test("the real projected store preserves complete counts while admitting one blob at a time", async () => {
  const f = fixture("ready");
  expect(await f.service.unitStats("owner")).toEqual({ scannedGames: 2,
    builtByUnit: { Marine: 2, Marauder: 2 }, totalUnitsLost: 14, lostGames: 2 });
  expect(f.detailsRead.mock.calls.map(([, ids, options]) => ({ ids, options }))).toEqual([
    { ids: ["g1"], options: { fields: ["buildLog", "macroBreakdown.player_stats"], concurrency: 1, strict: true } },
    { ids: ["g2"], options: { fields: ["buildLog", "macroBreakdown.player_stats"], concurrency: 1, strict: true } },
  ]);
  expect(f.limit).toHaveBeenCalledWith(1000);
  expect(f.store.bulkReadCapacitySnapshot()).toMatchObject({ active: 0, queued: 0 });
});
