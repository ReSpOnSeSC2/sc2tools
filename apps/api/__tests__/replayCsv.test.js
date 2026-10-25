// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { CatalogService } = require("../src/services/catalog");
const { buildCatalogRouter } = require("../src/routes/catalog");
const { csvCell } = require("../src/services/replayCsv");
const columns = require("../src/config/replayExportColumns.json");
const { parseFilters } = require("../src/util/parseQuery");
let mongo, db, service;
const game = (id, extra = {}) => ({ userId: "owner", gameId: String(id), date: new Date(Date.UTC(2026, 0, 1) + Number(id) * 1000),
  result: "Victory", myRace: "Protoss", myBuild: "Gateway", myMmr: 4200, myToonHandle: "2-S2-1-123", map: "Exact LE",
  isLadderGame: true, playerCount: 2, matchFormat: "1v1", opponent: { displayName: "Rival", race: "Terran", mmr: 4300, strategy: "Bio" }, ...extra });
beforeAll(async () => { mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "replay_csv_controls" }); });
afterAll(async () => { await db?.close(); await mongo?.stop(); });
beforeEach(async () => { jest.restoreAllMocks(); await db.games.deleteMany({}); service = new CatalogService(db, { projectDir: null }); });

function appFor() {
  const app = express();
  app.use(buildCatalogRouter({ catalog: service, auth: (req, res, next) => {
    if (!req.headers["x-test-owner"]) return res.status(401).json({ error: { code: "auth_required" } });
    req.auth = { userId: String(req.headers["x-test-owner"]) }; next();
  } }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: { code: err.code || "unexpected" } }));
  return app;
}
async function csv(filters = {}, opts = {}) {
  const prepared = await service.prepareCsv("owner", filters, opts); let text = "";
  for await (const chunk of prepared.stream) text += chunk;
  return { text, truncated: prepared.truncated };
}

test.each(["=SUM(A1:A2)", "+cmd", "-danger", "@value", "\t=SUM(A1)", "\r\n@value", " \uFEFF+formula"])("quotes a spreadsheet formula safely: %p", value => {
  const safe = csvCell(value);
  expect(safe.startsWith("'") || safe.startsWith('"\'')).toBe(true);
});
test("numeric values and ordinary quoted cells retain their meanings", () => {
  expect(csvCell(-42)).toBe("-42"); expect(csvCell(0)).toBe("0"); expect(csvCell(null)).toBe("");
  expect(csvCell('Map, "Quoted"\nLine')).toBe('"Map, ""Quoted""\nLine"');
});
test("exports a BOM/shared columns/current account+replay filters with no hidden, deleted or foreign rows", async () => {
  await db.games.insertMany([
    game(1, { myToonHandle: "2-s2-1-123", myBuild: "=PRIVATEFORMULA", opponent: { displayName: "+Rival", race: "Terran", strategy: "Bio", secret: "private-other-field" } }),
    game(2, { excluded: true }), game(3, { _deleted: true }), game(4, { _deletionPending: true }),
    game(5, { userId: "different-owner" }), game(6, { myToonHandle: "1-S2-1-999" }), game(7, { result: "Defeat" }), game(8, { map: "Other LE" }),
  ]);
  const find = jest.spyOn(db.games, "find");
  const out = await csv(parseFilters({ accounts: "2-S2-1-123", map: "Exact" }), { result: "win", matchup: "PvT", search: "Bio" });
  expect(out.truncated).toBe(false);
  expect(out.text.startsWith(`\uFEFF${columns.map(column => column.key).join(",")}\r\n`)).toBe(true);
  expect(out.text.split("\r\n").filter(Boolean)).toHaveLength(2);
  expect(out.text).toContain("'=PRIVATEFORMULA"); expect(out.text).toContain("'+Rival");
  expect(out.text).toContain("4200,PvT,EU");
  expect(out.text).toContain("https://sc2tools.com/app/game/1");
  expect(out.text).not.toContain("private-other-field");
  expect(find).toHaveBeenCalledTimes(2);
  expect(find.mock.calls[0][1].projection).toEqual({ _id: 1 });
  const projection = find.mock.calls[1][1].projection;
  expect(projection).not.toHaveProperty("opponent"); expect(projection).not.toHaveProperty("buildLog");
  find.mockRestore();
});
test("HTTP export is authenticated, private, states truncation and limits each owner independently", async () => {
  await db.games.insertMany([game(1), game(2, { userId: "other" })]);
  const app = appFor();
  expect((await request(app).get("/export.csv")).status).toBe(401);
  const first = await request(app).get("/export.csv").set("x-test-owner", "owner");
  expect(first.status).toBe(200); expect(first.headers["cache-control"]).toBe("private, no-store");
  expect(first.headers["x-export-truncated"]).toBe("false");
  expect(first.headers["content-type"]).toContain("text/csv");
  expect((await request(app).get("/export.csv").set("x-test-owner", "owner")).status).toBe(429);
  expect((await request(app).get("/export.csv").set("x-test-owner", "other")).status).toBe(200);
});
test("a 50,001-row library reports and streams exactly the 50,000-row cap", async () => {
  await db.games.insertMany(Array.from({ length: 50_001 }, (_, i) => game(i)));
  const prepared = await service.prepareCsv("owner", {});
  expect(prepared.truncated).toBe(true);
  let rows = -1, last = "";
  for await (const chunk of prepared.stream) { rows++; last = chunk; }
  expect(rows).toBe(50_000); expect(last.startsWith("1,")).toBe(true);
});
test("stream cancellation closes the metadata cursor, and ascending order follows the library", async () => {
  await db.games.insertMany([game(1), game(2), game(3)]);
  const ascending = await csv({}, { sort: "date_asc" });
  expect(ascending.text.split("\r\n")[1].startsWith("1,")).toBe(true);
  const controller = new AbortController(); const find = jest.spyOn(db.games, "find");
  const prepared = await service.prepareCsv("owner", {}, { signal: controller.signal });
  await prepared.stream.next(); await prepared.stream.next();
  const cursor = find.mock.results[1].value;
  const close = jest.spyOn(cursor, "close");
  controller.abort();
  await expect(prepared.stream.next()).rejects.toBeDefined();
  // Driver `closed` also requires an empty local batch, so verify resource
  // cleanup directly even when buffered rows remain after cancellation.
  expect(close).toHaveBeenCalled();
  expect(cursor.id?.isZero()).toBe(true); find.mockRestore();
});
