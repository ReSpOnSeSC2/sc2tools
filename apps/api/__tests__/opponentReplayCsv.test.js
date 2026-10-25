// @ts-nocheck
"use strict";
const express = require("express"), request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");
const { CatalogService } = require("../src/services/catalog");
const { buildCatalogRouter } = require("../src/routes/catalog");
let mongo, db, opponents;
const game = (id, extra = {}) => ({ userId: "owner", gameId: `${id}`, date: new Date(Date.UTC(2026,9,1) + id * 1000), result: "Victory", durationSec: 300, map: "Exact LE", myBuild: "Gateway", myRace: "Protoss", opponent: { pulseId: "a", pulseCharacterId: "101", race: "Zerg", strategy: "Pool" }, ...extra });
beforeAll(async () => { mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "dossier_csv" }); });
afterAll(async () => { await db?.close(); await mongo?.stop(); });
beforeEach(async () => {
  await Promise.all([db.games.deleteMany({}), db.opponents.deleteMany({})]);
  await db.opponents.insertMany([{ userId: "owner", pulseId: "a", pulseCharacterId: "101" }, { userId: "owner", pulseId: "b", pulseCharacterId: "202" }]);
  opponents = new OpponentsService(db, "test-pepper", { pulseLinks: { getLinks: jest.fn().mockResolvedValue({ links: new Map([["101", { accountId: "one" }], ["202", { accountId: "one" }]]), partial: false }) } });
});
async function csv(opts = {}, owner = "owner") {
  const prepared = await opponents.prepareGamesCsv(owner, "a", opts);
  if (!prepared) return null;
  let text = ""; for await (const chunk of prepared.stream) text += chunk;
  return { text, truncated: prepared.truncated, ids: text.split("\r\n").slice(1).filter(Boolean).map(line => line.split(",")[0]) };
}
test("CSV and existing replay pages share owner/opponent/map/build/strategy/result/sample scope", async () => {
  await db.games.insertMany([
    game(1), game(2,{ opponent: { pulseId: "b", pulseCharacterId: "202", race: "Zerg", strategy: "Pool" } }),
    game(3,{ result: "Defeat" }), game(4,{ map: "Another" }), game(5,{ myBuild: "Other" }), game(6,{ opponent: { pulseId: "a", strategy: "Hatch" } }),
    game(7,{ excluded: true }), game(8,{ _deleted: true }), game(9,{ _deletionPending: true }), game(10,{ userId: "other" }), game(11,{ opponent: { pulseId: "unrelated", strategy: "Pool" } }),
  ]);
  const opts = { mergeLinked: true, filters: { map: "Exact LE", build: "Gateway", oppStrategy: "Pool", since: new Date("2026-10-01"), until: new Date("2026-10-02") }, result: "win", analysisGameIds: ["1","2","3","7","10","11"] };
  const rows = await opponents.listGames("owner","a",opts), output = await csv(opts);
  expect(output.ids).toEqual(rows.items.map(row => row.id)); expect(output.ids).toEqual(["2","1"]); expect(output.truncated).toBe(false);
  expect(output.text.startsWith("\uFEFFgameId,")).toBe(true);
  expect((await csv({ ...opts, mergeLinked: false })).ids).toEqual(["1"]);
});
test("empty analysis samples stay empty, malformed samples fail closed, unowned dossiers return no export", async () => {
  await db.games.insertOne(game(1));
  expect((await csv({ analysisGameIds: [] })).ids).toEqual([]);
  await expect(csv({ analysisGameIds: "oops" })).rejects.toMatchObject({ status: 400, code: "invalid_analysis_game_ids" });
  expect(await csv({},"other")).toBeNull();
});
test("5,001 matching rows use the shared serializer and report exactly a 5,000-row cap without materializing replay details", async () => {
  await db.games.insertMany(Array.from({ length: 5001 },(_,i) => game(i + 1)));
  const find = jest.spyOn(db.games,"find"), output = await csv();
  expect(output.truncated).toBe(true); expect(output.ids).toHaveLength(5000); expect(output.ids[0]).toBe("5001"); expect(output.ids.at(-1)).toBe("2");
  expect(JSON.stringify(find.mock.calls.map(call => call[1]?.projection))).not.toMatch(/buildOrder|events|macroBreakdown|timeseries/); find.mockRestore();
});
function appFor() {
  const app = express();
  app.use(buildCatalogRouter({ opponents, catalog: new CatalogService(db, { projectDir:null }), auth: (req,res,next) => { if (!req.headers["x-owner"]) return res.status(401).end(); req.auth = { userId: req.headers["x-owner"] }; next(); } }));
  app.use((error,_req,res,_next) => res.status(error.status || 500).json({ error: { code: error.code || "unexpected" } })); return app;
}
test("dossier and full-library exports share one per-owner admission, private headers and streaming response", async () => {
  await db.games.insertOne(game(1)); const app = appFor();
  expect((await request(app).get("/opponents/a/export.csv")).status).toBe(401);
  const dossier = await request(app).get("/opponents/a/export.csv?result=win").set("x-owner","owner");
  expect(dossier.status).toBe(200); expect(dossier.headers["cache-control"]).toBe("private, no-store"); expect(dossier.headers["x-export-truncated"]).toBe("false"); expect(dossier.text).toContain("1,");
  expect((await request(app).get("/export.csv").set("x-owner","owner")).status).toBe(429);
  expect((await request(app).get("/opponents/a/export.csv").set("x-owner","other")).status).toBe(404);
});
