// @ts-nocheck
"use strict";

// Real app/auth + disposable Mongo prove stored provenance, not a mocked $set.
// The synthetic future-auth router below exercises the otherwise unreachable
// unknown-source branch without teaching production authentication a new source.
const express = require("express");
const request = require("supertest");
const { buildGamesRouter } = require("../src/routes/games");
const { ANALYSIS_PROVENANCE_PROJECTION } = require("../src/services/analysisProvenance");
const { startHarness, resetCollections, insertDeviceToken, userIdForClerk, sampleGame } = require("./helpers/browserIngestHarness");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async token => {
    if (token === "browser-token") return { sub: "clerk_user_browser" };
    throw new Error("invalid");
  }),
}));

let h, owner, device;
const post = (token, game) => request(h.app).post("/v1/games").set("authorization", `Bearer ${token}`).send({ games: [game] });
const row = id => h.db.games.findOne({ userId: owner, gameId: sampleGame(id).gameId });
const native = (id, extra = {}) => sampleGame(id, { ingestSource: "browser", engineVersion: "1.6.12", agentVersion: "0.24.9", ...extra });
const expectNoStamps = game => {
  expect(game).not.toHaveProperty("ingestSource");
  expect(game).not.toHaveProperty("engineVersion");
  expect(game).not.toHaveProperty("agentVersion");
};
const expectNative = game => expect(game).toMatchObject({ ingestSource: "agent", engineVersion: "1.6.12", agentVersion: "0.24.9" });

beforeAll(async () => { h = await startHarness("sc2tools_test_analysis_provenance"); });
afterAll(async () => { if (h) await h.stop(); });
beforeEach(async () => {
  await resetCollections(h.db);
  const established = await post("browser-token", sampleGame(0));
  expect(established.status).toBe(202);
  owner = await userIdForClerk(h.db, "clerk_user_browser");
  device = await insertDeviceToken(h.db, owner);
});

test("native parse versions stay slim and owner-readable; browser replacement drops only native identity", async () => {
  const uploaded = await post(device, native(1));
  expect(uploaded.status).toBe(202);
  expect(uploaded.body.accepted).toEqual([{ gameId: sampleGame(1).gameId, created: true }]);
  expectNative(await row(1));
  expectNative(await h.services.games.get(owner, sampleGame(1).gameId));
  expectNative((await h.services.games.findMany(owner, [sampleGame(1).gameId]))[0]);
  const detail = await h.db.gameDetails.findOne({ userId: owner, gameId: sampleGame(1).gameId });
  expect(detail.buildLog).toEqual(["[0:12] Pylon"]);
  expectNoStamps(detail);
  const replaced = await post("browser-token", sampleGame(1, { ingestSource: "agent", engineVersion: "1.6.11", agentVersion: "0.99.0" }));
  expect(replaced.status).toBe(202);
  expect(replaced.body.accepted).toEqual([{ gameId: sampleGame(1).gameId, created: false }]);
  expect(await row(1)).toMatchObject({ ingestSource: "browser", engineVersion: "1.6.11" });
  expect(await row(1)).not.toHaveProperty("agentVersion");
});

test.each([
  [{}, undefined, undefined],
  [{ engineVersion: "1.6.10" }, "1.6.10", undefined],
  [{ agentVersion: "0.24.7" }, undefined, "0.24.7"],
])("explicit route replacement clears independently missing stamps %j", async (versions, engine, agent) => {
  expect((await post(device, native(2))).status).toBe(202);
  // A payload cannot change the route's explicit full-analysis storage intent.
  const response = await post(device, sampleGame(2, { ...versions, replaceAnalysis: false }));
  expect(response.status).toBe(202);
  expect(response.body.accepted).toEqual([{ gameId: sampleGame(2).gameId, created: false }]);
  const stored = await row(2);
  expect(stored.ingestSource).toBe("agent");
  if (engine === undefined) expect(stored).not.toHaveProperty("engineVersion");
  else expect(stored.engineVersion).toBe(engine);
  if (agent === undefined) expect(stored).not.toHaveProperty("agentVersion");
  else expect(stored.agentVersion).toBe(agent);
  expect(stored).not.toHaveProperty("replaceAnalysis");
});

test("current device metadata is never substituted for missing parse stamps", async () => {
  await h.db.deviceTokens.updateMany({ userId: owner }, { $set: { agentVersion: "9.9.9" } });
  const response = await post(device, sampleGame(10));
  expect(response.status).toBe(202);
  const stored = await row(10);
  expect(stored.ingestSource).toBe("agent");
  expect(stored).not.toHaveProperty("engineVersion");
  expect(stored).not.toHaveProperty("agentVersion");
});

test("a future authenticated source cannot inherit or claim native/browser provenance", async () => {
  expect((await post(device, native(3))).status).toBe(202);
  const app = express();
  app.use(express.json());
  app.use(buildGamesRouter({ games: h.services.games, opponents: h.services.opponents,
    auth: (req, _res, next) => { req.auth = { userId: owner, source: "future-auth" }; next(); },
    testOnlyAllowMissingReplayIngestAdmission: true }));
  const response = await request(app).post("/games").send(native(3));
  expect(response.status).toBe(202);
  expect(response.body.accepted).toEqual([{ gameId: sampleGame(3).gameId, created: false }]);
  expectNoStamps(await row(3));
});

test("default metadata patches preserve old provenance even when their shape looks complete", async () => {
  expect((await post(device, native(4))).status).toBe(202);
  await h.services.games.upsertWithRevision(owner, sampleGame(4, {
    map: "Changed metadata", ingestSource: "browser", engineVersion: "9.9.9", agentVersion: "9.9.9",
  }));
  const stored = await row(4);
  expect(stored.map).toBe("Changed metadata");
  expectNative(stored);
  await h.services.games.upsert(owner, { gameId: sampleGame(4).gameId, date: sampleGame(4).date }, undefined, { replaceAnalysis: false });
  expectNative(await row(4));
});

test("metadata insertion cannot manufacture stamps; explicit replacement needs no shape heuristic", async () => {
  await h.services.games.upsert(owner, native(5));
  expectNoStamps(await row(5));
  expect((await post(device, native(5))).status).toBe(202);
  await h.services.games.upsert(owner, { gameId: sampleGame(5).gameId, date: sampleGame(5).date }, undefined, { replaceAnalysis: true });
  expectNoStamps(await row(5));
});

test.each([null, 249, [], {}, "latest", "v0.24.9", "0.24", "0.24.9-", "0.24.9-rc..1", `0.24.9-${"x".repeat(34)}`])(
  "direct full-analysis storage rejects malformed versions instead of retaining stale stamps: %p", async bad => {
    expect((await post(device, native(6))).status).toBe(202);
    await h.services.games.upsertWithRevision(owner, sampleGame(6, { ingestSource: "agent", engineVersion: bad, agentVersion: bad }), undefined, { replaceAnalysis: true });
    const stored = await row(6);
    expect(stored.ingestSource).toBe("agent");
    expect(stored).not.toHaveProperty("engineVersion");
    expect(stored).not.toHaveProperty("agentVersion");
  },
);

test("direct storage keeps valid40-character versions and drops versions without a known source", async () => {
  const version = `0.24.9-${"x".repeat(33)}`;
  expect(version).toHaveLength(40);
  await h.services.games.upsertWithRevision(owner, sampleGame(7, { ingestSource: "agent", engineVersion: version, agentVersion: version }), undefined, { replaceAnalysis: true });
  expect(await row(7)).toMatchObject({ ingestSource: "agent", engineVersion: version, agentVersion: version });
  await h.services.games.upsertWithRevision(owner, sampleGame(7, { ingestSource: "desktop", engineVersion: "1.6.12", agentVersion: "0.24.9" }), undefined, { replaceAnalysis: true });
  expectNoStamps(await row(7));
});

test("resume-marker operations preserve an existing parse and never manufacture a new parse stamp", async () => {
  expect((await post(device, native(8))).status).toBe(202);
  await h.services.games.quarantineResumedReplay(owner, native(8, { engineVersion: "9.9.9", agentVersion: "9.9.9" }));
  expectNative(await row(8));
  expect((await row(8)).isResumedFromReplay).toBe(true);
  await h.services.games.quarantineResumedReplay(owner, native(9));
  const marker = await row(9);
  expect(marker.isResumedFromReplay).toBe(true);
  expectNoStamps(marker);
});

test.each(["device", "browser"])("HTTP validation rejects bad agent versions per item before %s provenance stamping", async source => {
  const bad = [null, 249, {}, ["0.24.9"], "latest", `0.24.9-${"x".repeat(34)}`];
  const games = [native(20), ...bad.map((value, index) => native(21 + index, { agentVersion: value }))];
  const response = await request(h.app).post("/v1/games").set("authorization", `Bearer ${source === "device" ? device : "browser-token"}`).send({ games });
  expect(response.status).toBe(202);
  expect(response.body.accepted).toEqual([{ gameId: sampleGame(20).gameId, created: true }]);
  expect(response.body.rejected).toHaveLength(6);
  for (let index = 0; index < bad.length; index++) {
    expect(response.body.rejected[index]).toMatchObject({ gameId: sampleGame(21 + index).gameId });
    expect(response.body.rejected[index].errors[0]).toMatch(/^\/agentVersion /);
    expect(response.body.rejected[index].retryable).toBeUndefined();
    expect(await row(21 + index)).toBeNull();
  }
});

const forty = `0.24.9-${"x".repeat(33)}`;
test.each([
  ["valid40-character native versions", { ingestSource: "agent", engineVersion: forty, agentVersion: forty }, { ingestSource: "agent", engineVersion: forty, agentVersion: forty }],
  ["41-character legacy versions", { ingestSource: "agent", engineVersion: forty + "x", agentVersion: forty + "x" }, { ingestSource: "agent" }],
  ["object and array versions", { ingestSource: "agent", engineVersion: { version: "1.6.12" }, agentVersion: ["0.24.9"] }, { ingestSource: "agent" }],
  ["array and object versions", { ingestSource: "agent", engineVersion: ["1.6.12"], agentVersion: { version: "0.24.9" } }, { ingestSource: "agent" }],
  ["null and numeric versions", { ingestSource: "agent", engineVersion: null, agentVersion: 249 }, { ingestSource: "agent" }],
  ["malformed version strings", { ingestSource: "agent", engineVersion: "latest", agentVersion: "v0.24.9" }, { ingestSource: "agent" }],
  ["browser with forged agent version", { ingestSource: "browser", engineVersion: "1.6.12", agentVersion: "0.24.9" }, { ingestSource: "browser", engineVersion: "1.6.12" }],
  ["browser with an invalid engine", { ingestSource: "browser", engineVersion: {}, agentVersion: forty }, { ingestSource: "browser" }],
  ["unknown source", { ingestSource: "desktop", engineVersion: "1.6.12", agentVersion: "0.24.9" }, {}],
  ["object source", { ingestSource: { source: "agent" }, engineVersion: "1.6.12", agentVersion: "0.24.9" }, {}],
  ["array source", { ingestSource: ["agent"], engineVersion: "1.6.12", agentVersion: "0.24.9" }, {}],
  ["missing source", { engineVersion: "1.6.12", agentVersion: "0.24.9" }, {}],
  ["missing versions", { ingestSource: "agent" }, { ingestSource: "agent" }],
])("bounds raw legacy/restored %s in Mongo before get/list/findMany materialize DTOs", async (_label, fields, expected) => {
  const game = { ...sampleGame(40), date: new Date(sampleGame(40).date), userId: owner, ...fields };
  // Deliberately bypass the new route/storage normalizers, as old rows and
  // snapshot restore can do. These values must remain safe to read unchanged.
  await h.db.games.insertOne(game);
  const filter = { userId: owner, gameId: game.gameId };
  const projected = await h.db.games.findOne(filter, { projection: { _id: 0, ...ANALYSIS_PROVENANCE_PROJECTION } });
  expect(projected).toEqual(expected);
  const one = jest.spyOn(h.db.games, "findOne"), many = jest.spyOn(h.db.games, "find");
  let dtos;
  try {
    const detail = await h.services.games.get(owner, game.gameId);
    const page = await h.services.games.list(owner, { limit: 20 });
    const selected = await h.services.games.findMany(owner, [game.gameId]);
    dtos = [detail, page.items.find(item => item.gameId === game.gameId), selected[0]];
    expect(one).toHaveBeenCalledWith(expect.objectContaining(filter), expect.objectContaining({ projection: expect.objectContaining(ANALYSIS_PROVENANCE_PROJECTION) }));
    expect(many.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of many.mock.calls) expect(call[1].projection).toEqual(expect.objectContaining(ANALYSIS_PROVENANCE_PROJECTION));
  } finally { one.mockRestore(); many.mockRestore(); }
  for (const dto of dtos) {
    expect(dto).toBeDefined();
    for (const field of ["ingestSource", "engineVersion", "agentVersion"]) {
      if (Object.hasOwn(expected, field)) expect(dto[field]).toBe(expected[field]);
      else expect(dto).not.toHaveProperty(field);
    }
  }
  const unchanged = await h.db.games.findOne(filter);
  for (const [field, value] of Object.entries(fields)) expect(unchanged[field]).toEqual(value);
});
