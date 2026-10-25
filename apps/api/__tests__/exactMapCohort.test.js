// @ts-nocheck
"use strict";

const request = require("supertest");
const { createHarness } = require("./helpers/reviewsHarness");
const { parseExactMapNames } = require("../src/util/exactMapFilter");
jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
let h;
const at = Date.parse("2026-10-20T12:00:00Z");
const get = (path, names, extra = {}) => request(h.app).get(`/v1/${path}`).query({ map_exact: JSON.stringify(names), ...extra }).set("authorization", h.bearer("owner"));
function game(gameId, map, offset, patch = {}) {
  return { userId: "u_owner", gameId, map, date: new Date(at + offset * 1000), result: "Victory", myRace: "Protoss", isLadderGame: true,
    matchFormat: "1v1", playerCount: 2, durationSec: 600, opponent: { displayName: "Fixture rival", race: "Zerg" }, ...patch };
}
beforeAll(async () => { h = await createHarness(); await h.seedUser("owner"); await h.seedUser("other"); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { jest.restoreAllMocks(); await h.db.games.deleteMany({}); await h.db.opponents.deleteMany({}); });

test("one exact alias cohort selects the displayed combined map record across list, map stats and neighbors", async () => {
  await h.db.games.insertMany([
    game("alpha-old", "Alpha", -10), game("prefix-old", "Alphabet", -1), game("current", "Alpha LE", 0),
    game("prefix-new", "Alpha LE extra", 1), game("alpha-new", "Alpha", 10),
    game("foreign", "Alpha", -2, { userId: "u_other" }), game("terran", "Alpha", -3, { opponent: { race: "Terran" } }),
  ]);
  const query = { map: "Alpha LE", opp_race: "Z" }, names = ["Alpha LE", "Alpha"];
  const list = await get("games-list", names, query);
  expect(list.status).toBe(200); expect(list.body.total).toBe(3);
  expect(list.body.games.map((row) => row.id).sort()).toEqual(["alpha-new", "alpha-old", "current"]);
  const stats = await get("maps/matchups", names, query);
  expect(stats.status).toBe(200); expect(stats.body.reduce((n, row) => n + row.total, 0)).toBe(3);
  expect(stats.body.map((row) => row.map).sort()).toEqual(["Alpha", "Alpha LE"]);
  const aggregate = jest.spyOn(h.db.games, "aggregate"), read = jest.spyOn(h.db.games, "findOne");
  const neighbors = await get("games/current/neighbors", names, query);
  expect(neighbors.status).toBe(200);
  expect(neighbors.body).toMatchObject({ prev: { gameId: "alpha-old" }, next: { gameId: "alpha-new" } });
  expect(read).toHaveBeenCalledTimes(3); expect(aggregate).not.toHaveBeenCalled();
});

test("an edition's drilldown excludes distinct Roman-numeral prefix names and regex characters stay literal", async () => {
  await h.db.games.insertMany([game("two", "Sanctuary II", -2), game("three", "Sanctuary III", -1), game("literal", "A.* LE", 0), game("regex", "Anything LE", 1)]);
  expect((await get("games-list", ["Sanctuary II"], { map: "Sanctuary II" })).body.games.map((row) => row.id)).toEqual(["two"]);
  expect((await get("games-list", ["A.* LE"])).body.games.map((row) => row.id)).toEqual(["literal"]);
});

test("global exact-map filters agree across cached opponent profile panels and the filtered opponent list", async () => {
  const pulseId = "1-S2-1-424242", opponent = { pulseId, toonHandle: pulseId, displayName: "Fixture rival", race: "Zerg" };
  await h.db.opponents.insertOne({ userId: "u_owner", pulseId, toonHandle: pulseId, displayNameSample: "Fixture rival", race: "Z", gameCount: 99, wins: 99, losses: 0, firstSeen: new Date(at), lastSeen: new Date(at) });
  await h.db.games.insertMany([game("alias", "Alpha", -2, { opponent }), game("edition", "Alpha LE", -1, { opponent }), game("prefix", "Alphabet", 0, { opponent })]);
  const profile = await get(`opponents/${pulseId}`, ["Alpha LE", "Alpha"], { map: "Alpha LE" });
  expect(profile.status).toBe(200); expect(profile.body.totals.total).toBe(2);
  expect(profile.body.games.map((row) => row.id)).toEqual(["edition", "alias"]);
  expect(Object.keys(profile.body.byMap).sort()).toEqual(["Alpha", "Alpha LE"]);
  // No legacy substring param: exact-map alone must invalidate lifetime counters.
  const list = await get("opponents", ["Alpha LE", "Alpha"]);
  expect(list.status).toBe(200); expect(list.body.items[0].gameCount).toBe(2);
  const empty = await get(`opponents/${pulseId}`, ["Absent"]);
  expect(empty.body.totals.total).toBe(0); expect(empty.body.games).toEqual([]);
});

test.each(["{}", "[]", "null", "not-json", JSON.stringify([" "]), JSON.stringify(["bad\u0000name"]), JSON.stringify(["x".repeat(201)]),
  JSON.stringify(Array.from({ length: 17 }, (_, i) => `Map ${i}`)), JSON.stringify(Array.from({ length: 16 }, (_, i) => `${i}${"é".repeat(100)}`))])("rejects invalid or oversized exact cohorts instead of broadening a request: %s", async (raw) => {
  for (const path of ["games-list", "maps/matchups", "games/current/neighbors"]) {
    const response = await request(h.app).get(`/v1/${path}`).query({ map_exact: raw }).set("authorization", h.bearer("owner"));
    expect(response.status).toBe(400);
  }
});

test("deduplicates bounded exact names without altering stored spelling", () => {
  expect(parseExactMapNames(JSON.stringify(["Alpha LE", "Alpha", "Alpha LE"]))).toEqual(["Alpha LE", "Alpha"]);
});
