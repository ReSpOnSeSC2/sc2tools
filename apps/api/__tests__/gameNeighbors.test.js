// @ts-nocheck
"use strict";

const request = require("supertest");
const { ObjectId } = require("mongodb");
const { createHarness } = require("./helpers/reviewsHarness");
const { GamesService } = require("../src/services/games");
const { ReplayLibraryService } = require("../src/services/replayLibrary");
jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
let h, service;
const at = new Date("2026-10-20T12:00:00Z");
const oid = (n) => new ObjectId(n.toString(16).padStart(24, "0"));
const get = (id = "current", query = "", user = "owner") => request(h.app).get(`/v1/games/${id}/neighbors${query}`).set("authorization", h.bearer(user));
function game(id, offset = 0, patch = {}) {
  return { userId: "u_owner", gameId: id, date: new Date(at.getTime() + offset * 1000), result: "Victory", map: "Alcyone [LE]",
    myRace: "Protoss", myBuild: "Blink pressure", macroScore: 80, durationSec: 600, isLadderGame: true, matchFormat: "1v1", playerCount: 2,
    opponent: { displayName: "Fixture Rival", pulseId: "owner-private-pulse", race: "Zerg", strategy: "Roaches", mmr: 4200, region: "NA", toonHandle: "1-S2-1-private", pulseCharacterId: "private-character" },
    buildLog: [{ secret: "heavy-private-detail" }], buildIntent: { notes: "private-checkin-note" }, ...patch };
}
beforeAll(async () => { h = await createHarness(); await h.seedUser("owner"); await h.seedUser("other"); service = new GamesService(h.db); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { jest.restoreAllMocks(); await h.db.games.deleteMany({}); await h.db.opponents.deleteMany({}); });

test("returns immediate older/newer owner summaries and cached H2H using three slim game reads", async () => {
  await h.db.games.insertMany([game("older", -2), game("current"), game("newer", 2), game("foreign", -1, { userId: "u_other" }), game("resumed", 1, { isResumedFromReplay: true })]);
  await h.db.opponents.insertMany([{ userId: "u_owner", pulseId: "owner-private-pulse", wins: 3, losses: 2, gameCount: 5, notes: "private-owner-note" },
    { userId: "u_other", pulseId: "owner-private-pulse", wins: 99, losses: 0, gameCount: 99 }]);
  const games = jest.spyOn(h.db.games, "findOne"), opponents = jest.spyOn(h.db.opponents, "findOne");
  const aggregate = jest.spyOn(h.db.games, "aggregate");
  const response = await get();
  expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.body).toMatchObject({ prev: { gameId: "older", myBuild: "Blink pressure", opponent: { pulseId: "owner-private-pulse" } }, next: { gameId: "newer" }, h2h: { wins: 3, losses: 2 } });
  expect(games).toHaveBeenCalledTimes(3); expect(opponents).toHaveBeenCalledTimes(1); expect(aggregate).not.toHaveBeenCalled();
  expect(opponents).toHaveBeenCalledWith({ userId: "u_owner", pulseId: "owner-private-pulse" }, { projection: { _id: 0, wins: 1, losses: 1, gameCount: 1 } });
  for (const [, options] of games.mock.calls) {
    for (const field of Object.keys(options.projection)) expect(field).not.toMatch(/^(buildLog|macroBreakdown|buildIntent|replayFile)(\.|$)/);
  }
  const json = JSON.stringify(response.body);
  for (const secret of ["heavy-private-detail", "private-checkin-note", "private-owner-note", "private-character", "_id", "userId"]) expect(json).not.toContain(secret);
  expect(Buffer.byteLength(json)).toBeLessThan(1000);
});

test("date/id ties and mixed BSON date cohorts have no missing neighbors", async () => {
  const dates = [at, at, "2026-10-19T12:00:00Z", "2026-10-19T12:00:00Z", 123, 123, null, undefined];
  await h.db.games.insertMany(dates.map((date, index) => game(`row-${index}`, 0, { _id: oid(index + 1), date, opponent: {} })));
  const ordered = await h.db.games.find({ userId: "u_owner" }).sort({ date: -1, _id: -1 }).toArray();
  for (let index = 0; index < ordered.length; index++) {
    const result = await service.neighbors("u_owner", ordered[index].gameId);
    expect(result.prev?.gameId ?? null).toBe(ordered[index + 1]?.gameId ?? null);
    expect(result.next?.gameId ?? null).toBe(ordered[index - 1]?.gameId ?? null);
  }
});

test.each(["opponent", "matchup", "build"])("%s scope selects the actual current-game cohort", async (scope) => {
  const current = game("current");
  if (scope === "build") current.buildIntent = { status: "confirmed", applied: true, build: { name: "Blink pressure" }, detected: { name: "Detected opener" } };
  const mismatch = scope === "opponent" ? { opponent: { ...current.opponent, pulseId: "different-opponent" } }
    : scope === "matchup" ? { opponent: { ...current.opponent, race: "Terran" } } : { myBuild: "Detected opener" };
  await h.db.games.insertMany([game("right-older", -10), game("wrong-older", -1, mismatch), current, game("wrong-newer", 1, mismatch), game("right-newer", 10)]);
  expect((await get("current", `?scope=${scope}`)).body).toMatchObject({ prev: { gameId: "right-older" }, next: { gameId: "right-newer" } });
});

test.each(["race=P", "opp_race=Z", "map=Alcyone", "mmr_min=4000", "mmr_max=4500", "macro_min=70", "macro_max=90",
  "build=Blink%20pressure", "opp_strategy=Roaches", "min_minutes=6", "max_minutes=11", "map_pool=ladder", "game_size=1v1", "regions=NA", "result=win", "matchup=PvZ", "q=%5BLE%5D"])("standard filter %s remains applied to neighbors", async (query) => {
  const wrong = { myRace: "Terran", myBuild: "Other", map: "Other LE", macroScore: 20, durationSec: 180,
    isLadderGame: false, isLadderMap: true, matchFormat: "team", playerCount: 4, result: "Defeat",
    opponent: { race: "Protoss", strategy: "Other", mmr: 5000, region: "EU" } };
  // Each bound excludes a distinct deliberately invalid field, including the
  // upper bounds whose comparison direction differs from the lower ones.
  if (query.startsWith("mmr_min")) wrong.opponent.mmr = 1000;
  if (query.startsWith("macro_max")) wrong.macroScore = 95;
  if (query.startsWith("max_minutes")) wrong.durationSec = 900;
  await h.db.games.insertMany([game("valid", -10), game("invalid", -1, wrong), game("current")]);
  expect((await get("current", `?${query}`)).body.prev?.gameId).toBe("valid");
});

test("date filters constrain the origin view without losing owner isolation", async () => {
  await h.db.games.insertMany([game("older", -10), game("current"), game("newer", 10)]);
  const since = encodeURIComponent(new Date(at.getTime() - 5000).toISOString());
  const until = encodeURIComponent(new Date(at.getTime() + 5000).toISOString());
  expect((await get("current", `?since=${since}&until=${until}`)).body).toEqual({ prev: null, next: null });
});

test.each([["opponent", { opponent: {} }], ["matchup", { myRace: null }], ["build", { myBuild: null }]])("a missing %s identity never silently broadens the scope", async (scope, patch) => {
  await h.db.games.insertMany([game("older", -1), game("current", 0, patch), game("newer", 1)]);
  expect((await get("current", `?scope=${scope}`)).body).toEqual({ prev: null, next: null });
});

test("anonymous/foreign/absent/resumed games stay inaccessible and invalid scopes are rejected", async () => {
  await h.db.games.insertMany([game("current"), game("foreign", 0, { userId: "u_other" }), game("resumed", 0, { isResumedFromReplay: true })]);
  expect((await request(h.app).get("/v1/games/current/neighbors")).status).toBe(401);
  for (const id of ["foreign", "missing", "resumed"]) expect((await get(id)).status).toBe(404);
  expect((await get("current", "?scope=unknown")).status).toBe(400);
  expect((await get("current", "?scope=all&scope=opponent")).status).toBe(400);
});

test.each([{ wins: null, losses: 0 }, { wins: -1, losses: 2 }, { wins: 1.5, losses: 2 }, { wins: 0, losses: 0 }, { wins: 3, losses: 2, gameCount: 4 }])("invalid or unmeasured H2H counts are omitted (%j)", async (counts) => {
  await h.db.games.insertOne(game("current"));
  await h.db.opponents.insertOne({ userId: "u_owner", pulseId: "owner-private-pulse", ...counts });
  expect((await get()).body).toEqual({ prev: null, next: null });
});

test("optional cached H2H failure does not discard navigation", async () => {
  await h.db.games.insertMany([game("older", -1), game("current")]);
  jest.spyOn(h.db.opponents, "findOne").mockRejectedValue(new Error("synthetic cached metadata outage"));
  expect((await get()).body).toMatchObject({ prev: { gameId: "older" }, next: null });
});

test("the real lookup and directional query plans use owner indexes with no blocking sort", async () => {
  await h.db.games.insertMany(Array.from({ length: 200 }, (_, index) => game(`history-${index}`, index - 100)));
  const read = jest.spyOn(h.db.games, "findOne");
  await service.neighbors("u_owner", "history-100");
  expect(read).toHaveBeenCalledTimes(3);
  for (let index = 0; index < read.mock.calls.length; index++) {
    const [filter, options] = read.mock.calls[index];
    const query = h.db.games.find(filter, { projection: options.projection, ...(options.hint ? { hint: options.hint } : {}) });
    const plan = await (options.sort ? query.sort(options.sort) : query).limit(1).explain("executionStats");
    const winning = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(winning).toContain("IXSCAN"); expect(winning).toContain(index === 0 ? "userId_1_gameId_1" : "userId_1_date_-1__id_-1");
    expect(winning).not.toContain('"stage":"SORT"'); expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(2);
  }
});

test("pulse identities appear in owned replay/profile rows while public archive DTOs still omit them", async () => {
  await h.db.games.insertOne(game("current"));
  await h.db.opponents.insertOne({ userId: "u_owner", pulseId: "owner-private-pulse", wins: 1, losses: 0, gameCount: 1 });
  const library = new ReplayLibraryService(h.db);
  expect((await library.list("u_owner")).items[0].opponent.pulseId).toBe("owner-private-pulse");
  expect((await library.getDetail("u_owner", "current")).game.opponent.pulseId).toBe("owner-private-pulse");
  for (const row of (await library.list("u_owner", { view: "detector" })).items) expect(row.opponent).not.toHaveProperty("pulseId");
  expect((await library.getDetail("u_owner", "current", { view: "detector" })).game.opponent).not.toHaveProperty("pulseId");
  const ownHistory = await h.services.opponents.listGames("u_owner", "owner-private-pulse");
  expect(ownHistory.items[0].opponent_pulse_id).toBe("owner-private-pulse");
  const ownProfile = await h.services.opponents.get("u_owner", "owner-private-pulse");
  expect(ownProfile.games[0].opponent_pulse_id).toBe("owner-private-pulse");
  const sharing = await request(h.app).put("/v1/me/replay-sharing").set("authorization", h.bearer("owner")).send({ enabled: true });
  expect(sharing.status).toBe(200);
  for (const suffix of ["", "/current"]) {
    const publicRequest = request(h.app).get(`/v1/public/replays/${sharing.body.handle}${suffix}`);
    // The archive is anonymous; shared per-game analysis keeps its existing
    // signed-in viewer gate and must still hide the shared owner's identity.
    const publicResponse = await (suffix ? publicRequest.set("authorization", h.bearer("other")) : publicRequest);
    expect(publicResponse.status).toBe(200);
    expect(JSON.stringify(publicResponse.body)).not.toContain("owner-private-pulse");
    expect(JSON.stringify(publicResponse.body)).not.toContain("opponent_pulse_id");
  }
});

test("malformed or absent owned pulse identifiers stay omitted instead of being truncated into a link", async () => {
  const identities = [undefined, "", "bad\u0000id", "x".repeat(201)];
  await h.db.games.insertMany(identities.map((pulseId, index) => game(`bad-${index}`, index, { opponent: { pulseId, displayName: "Rival" } })));
  const library = new ReplayLibraryService(h.db);
  for (const row of (await library.list("u_owner")).items) expect(row.opponent).not.toHaveProperty("pulseId");
});
