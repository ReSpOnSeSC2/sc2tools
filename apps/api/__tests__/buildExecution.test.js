// @ts-nocheck
"use strict";
const request = require("supertest");
const { createHarness } = require("./helpers/reviewsHarness");
const { BuildExecutionService, CACHE_LIMIT, BASELINE_LIMIT, TTL_MS, MAX_WORK } = require("../src/services/buildExecution");
jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
let h;
const date = new Date("2026-10-20"), rule = { type: "count_min", name: "BuildStargate", time_lt: 300, count: 2 };
const endpoint = (id = "current", owner = "owner") => request(h.app).get(`/v1/games/${id}/build-execution`).set("authorization", h.bearer(owner));
const baseline = () => ({ timingSampleSelected: 25, timingSampleGames: 20, matchupTimingsLegacy: { PvZ: { timings: { Stargate: { sampleCount: 6, medianSeconds: 230, p25Seconds: 220, p75Seconds: 240, samples: [{ gameId: "DO_NOT_FORWARD" }] } } } } });
async function seed(id = "current", patch = {}) {
  await h.db.games.insertOne({ userId: "u_owner", gameId: id, date, myBuild: "Catalog opening", myRace: "Protoss", opponent: { race: "Zerg" }, durationSec: 600, ...patch });
  await h.services.gameDetails.upsert("u_owner", id, date, { buildLog: ["[0:00] Nexus", "[3:50] Stargate", "[4:50] Stargate"] });
}
beforeAll(async () => { h = await createHarness(); await h.seedUser("owner"); await h.seedUser("other"); });
afterAll(async () => { await h.close(); });
beforeEach(async () => {
  jest.restoreAllMocks(); await h.db.games.deleteMany({}); await h.db.customBuilds.deleteMany({}); await h.db.gameDetails.deleteMany({});
  h.services.gameExecution.invalidateForUser("u_owner");
  jest.spyOn(h.services.builds, "detail").mockResolvedValue(baseline());
  jest.spyOn(h.services.customBuilds, "evaluateBuild").mockResolvedValue(baseline());
});
async function custom() { await h.db.customBuilds.insertOne({ userId: "u_owner", slug: "private", name: "Saved opening", race: "Protoss", vsRace: "Zerg", perspective: "you", rules: [rule], schemaVersion: 3 }); }
test("owner-only private endpoint, hidden owner games stay readable, deleted/pending/foreign games never hydrate", async () => {
  await seed("current", { excluded: true });
  const reader = jest.spyOn(h.services.perGame, "buildExecutionEvents");
  expect((await endpoint("current", "other")).status).toBe(404);
  expect(reader).not.toHaveBeenCalled();
  const response = await endpoint();
  expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.body).toMatchObject({ source: "detected", rules: [], matchPct: null, timingMinSample: 3, timingSampleSelected: 25, timingSampleGames: 20 });
  expect(response.body.timings[0]).toMatchObject({ token: "Stargate", thisGameSec: 230, medianSec: 230, n: 6 });
  expect(JSON.stringify(response.body)).not.toMatch(/DO_NOT_FORWARD|samples|buildLog|userId|gameId/);
  for (const flag of ["_deleted", "_deletionPending"]) {
    await h.db.games.updateOne({ gameId: "current" }, { $set: { [flag]: true } });
    expect((await endpoint()).status).toBe(404);
    await h.db.games.updateOne({ gameId: "current" }, { $unset: { [flag]: "" } });
  }
  expect((await request(h.app).get("/v1/games/current/build-execution")).status).toBe(401);
});
test("confirmed exact custom build wins over detected catalog and uses its own rules", async () => {
  await custom(); await seed("current", { buildIntent: { status: "confirmed", applied: true, build: { name: "Saved opening", source: "custom", slug: "private" } } });
  const response = await endpoint();
  expect(response.body).toMatchObject({ source: "confirmed", build: { slug: "private", source: "custom" }, matchPct: 100, passedCount: 1, knownCount: 1, ruleCount: 1 });
  expect(response.body.rules[0]).toMatchObject({ got: 2, need: 2, evidenceSec: 290, evidenceKind: "event" });
  expect(h.services.customBuilds.evaluateBuild).toHaveBeenCalledTimes(1); expect(h.services.builds.detail).not.toHaveBeenCalled();
});
test("missing own logs do not hydrate any baseline and negative rules remain unknown", async () => {
  await custom(); await seed("current", { _customBuildSlug: "private" });
  await h.db.customBuilds.updateOne({ slug: "private" }, { $set: { rules: [{ ...rule, type: "not_before" }] } });
  await h.services.gameDetails.upsert("u_owner", "current", date, { buildLog: [] });
  const response = await endpoint();
  expect(response.body).toMatchObject({ unavailable: "log_missing", matchPct: null, knownCount: 0, rules: [{ unavailable: true, got: null, evidenceSec: null }] });
  expect(h.services.customBuilds.evaluateBuild).not.toHaveBeenCalled(); expect(h.services.builds.detail).not.toHaveBeenCalled();
});
test("a deleted custom identity never falls back to a same-name catalog grade or baseline", async () => {
  await seed("current", { _customBuildSlug: "missing" });
  expect((await endpoint()).body).toMatchObject({ unavailable: "definition_missing", build: { deleted: true }, rules: [], matchPct: null });
  expect(h.services.builds.detail).not.toHaveBeenCalled();
});
test.each([null, "..", "../other"])("an invalid or missing declared custom identity cannot become a same-name catalog lookup: %j", async slug => {
  await seed("current", { buildIntent: { status: "confirmed", applied: true, build: { name: "Catalog opening", source: "custom", slug } } });
  expect((await endpoint()).body).toMatchObject({ unavailable: "definition_missing", build: { source: "custom", deleted: true }, matchPct: null });
  expect(h.services.builds.detail).not.toHaveBeenCalled();
});
test("valid worker-only evidence can check rules without a useless timing hydration", async () => {
  await custom(); await seed("current", { _customBuildSlug: "private" });
  await h.services.gameDetails.upsert("u_owner", "current", date, { buildLog: ["[0:15] Probe"] });
  expect((await endpoint()).body).toMatchObject({ matchPct: 0, knownCount: 1, timings: [] });
  expect(h.services.customBuilds.evaluateBuild).not.toHaveBeenCalled();
});
test.each([{ buildLog: ['malformed retained legacy log'] }, { buildLog: ['[0:10] RewardBadge', '[0:20] BeaconFoo'] }])("unparseable/noise-only raw logs never establish negative or exact-zero rules: %j", async ({ buildLog }) => {
  await custom(); await seed("current", { _customBuildSlug: "private" });
  await h.db.customBuilds.updateOne({ slug: "private" }, { $set: { rules: ["not_before", "count_max", "count_exact"].map(type => ({ type, name: "BuildGateway", time_lt: 120, count: 0 })) } });
  await h.services.gameDetails.upsert("u_owner", "current", date, { buildLog });
  const body = (await endpoint()).body;
  expect(body).toMatchObject({ unavailable: "log_missing", matchPct: null, knownCount: 0 });
  expect(body.rules).toHaveLength(3);
  for (const row of body.rules) expect(row).toMatchObject({ unavailable: true, pass: false, got: null, evidenceSec: null });
  expect(h.services.customBuilds.evaluateBuild).not.toHaveBeenCalled();
});
test("neighboring game/card/timeline reads reuse one compact baseline and rule edits change the hash", async () => {
  await custom(); await seed("current", { _customBuildSlug: "private" }); await seed("neighbor", { _customBuildSlug: "private" });
  await endpoint(); await endpoint(); await endpoint("neighbor");
  expect(h.services.customBuilds.evaluateBuild).toHaveBeenCalledTimes(1);
  expect(JSON.stringify([...h.services.gameExecution.baselines.values()])).not.toContain("DO_NOT_FORWARD");
  await h.db.customBuilds.updateOne({ slug: "private" }, { $set: { rules: [{ ...rule, count: 3 }] } });
  expect((await endpoint()).body.matchPct).toBe(0);
  expect(h.services.customBuilds.evaluateBuild).toHaveBeenCalledTimes(2);
});
test("Reference practice priority is advertised without retaining reference steps in the shared scorecard response", async () => {
  await custom(); await seed("current", { _customBuildSlug: "private" });
  await h.db.customBuilds.updateOne({ slug: "private" }, { $set: { buildOrder: { v: 1, source: "manual", steps: [{ t: 60, supply: 16, action: "Stargate", note: "PRIVATE_REFERENCE_NOTE" }] } } });
  const body = (await endpoint()).body;
  expect(body.build.hasReferenceBuildOrder).toBe(true);
  expect(JSON.stringify(body)).not.toContain("PRIVATE_REFERENCE_NOTE"); expect(body.build.buildOrder).toBeUndefined();
});
test.each([{ race: "Terran" }, { vsRace: "Terran" }])("edited definition races cannot grade an incompatible historic game: %j", async patch => {
  await custom(); await seed("current", { _customBuildSlug: "private" });
  expect((await endpoint()).body.matchPct).toBe(100);
  await h.db.customBuilds.updateOne({ slug: "private" }, { $set: patch });
  expect((await endpoint()).body).toMatchObject({ unavailable: "matchup_mismatch", matchPct: null, rules: [], timings: [] });
});
test("actual detail-log replacement invalidates unchanged game/build/rule keys immediately", async () => {
  await custom(); await seed("current", { _customBuildSlug: "private" });
  expect((await endpoint()).body.matchPct).toBe(100);
  await h.services.gameDetails.upsert("u_owner", "current", date, { buildLog: ["[0:00] Nexus", "[3:50] Stargate"] });
  expect((await endpoint()).body).toMatchObject({ matchPct: 0, rules: [{ got: 1, evidenceKind: "deadline" }] });
});
test("visibility, definition and confirmed-label notifications retire existing owner baselines", async () => {
  const { HIDE_REASONS } = require("../src/services/gameControls");
  await seed(); await endpoint(); expect(h.services.gameExecution.cache.size).toBeGreaterThan(0);
  await h.services.gameControls.setExcluded("u_owner", "current", { excluded: true, reason: HIDE_REASONS[0] });
  expect(h.services.gameExecution.cache.size).toBe(0); expect(h.services.gameExecution.baselines.size).toBe(0);
  await endpoint(); await h.services.customBuilds.onDefinitionsChanged("u_owner"); expect(h.services.gameExecution.cache.size).toBe(0);
  await endpoint(); h.services.buildIntents.notifier.gamesChanged("u_owner"); expect(h.services.gameExecution.cache.size).toBe(0);
  await endpoint(); await h.services.customBuilds.onReclassified("u_owner", { tagged: 1, cleared: 0 }); expect(h.services.gameExecution.cache.size).toBe(0);
});
test("actual catalog hydration excludes private same-name, hidden, deleted and pending contributions", async () => {
  h.services.builds.detail.mockRestore(); await seed();
  for (const [id, patch] of [["prior-a", {}], ["prior-b", {}], ["private-copy", { _customBuildSlug: "unrelated" }], ["hidden", { excluded: true }], ["deleted", { _deleted: true }], ["pending", { _deletionPending: true }]]) {
    await seed(id, { ...patch, _deleted: false, _deletionPending: false });
    await h.db.games.updateOne({ gameId: id }, { $set: patch });
  }
  const hydrate = jest.spyOn(h.services.gameDetails, "findMany");
  const body = (await endpoint()).body;
  expect(body.timingSampleSelected).toBe(3); expect(body.timings[0]).toMatchObject({ n: 3, medianSec: 230 });
  const ids = hydrate.mock.calls.flatMap(([, ids]) => ids);
  for (const id of ["private-copy", "hidden", "deleted", "pending"]) expect(ids).not.toContain(id);
  expect(ids.filter(id => id === "current").length).toBeLessThanOrEqual(2); // own evidence + one shared baseline occurrence
});
test.each(["5.0.15", "5.0.16"])("rule evidence and displayed build order share construction starts in era%s", async gameVersion => {
  await custom(); await h.db.customBuilds.updateOne({ slug: "private" }, { $set: { race: "Zerg", rules: [{ ...rule, name: "BuildLair", count: 1, time_lt: 300 }] } });
  await seed("current", { _customBuildSlug: "private", myRace: "Zerg", gameVersion });
  await h.services.gameDetails.upsert("u_owner", "current", date, { buildLog: ["[0:00] Hatchery", "[4:00] Lair"] });
  const timeline = await h.services.perGame.buildOrder("u_owner", "current");
  const body = (await endpoint()).body, lair = timeline.events.find(row => row.name === "Lair");
  expect(body.rules[0]).toMatchObject({ pass: true, evidenceSec: lair.time }); expect(lair.time).toBeLessThan(240);
  expect(lair.complete_time).toBe(240);
});
test("a held baseline cannot populate or return after owner visibility invalidation", async () => {
  await seed(); let release; const held = new Promise(resolve => { release = resolve; });
  h.services.builds.detail.mockReturnValueOnce(held);
  const pending = endpoint().then(value => value);
  while (!h.services.builds.detail.mock.calls.length) await new Promise(resolve => setImmediate(resolve));
  h.services.gameExecution.invalidateForUser("u_owner"); release(baseline());
  expect((await pending).status).toBe(503);
  expect(h.services.gameExecution.cache.size).toBe(0);
});
test("a ranged history wipe retires a surviving game's cached timing baseline", async () => {
  await seed(); await seed("prior", { date: new Date("2026-10-19T12:00:00Z") });
  expect((await endpoint()).body.timings[0].medianSec).toBe(230);
  const next = baseline(); next.matchupTimingsLegacy.PvZ.timings.Stargate.medianSeconds = 260;
  h.services.builds.detail.mockResolvedValueOnce(next);
  await h.services.gdpr.wipeGames("u_owner", { since: new Date("2026-10-19T00:00:00Z"), until: new Date("2026-10-20T00:00:00Z") });
  expect(await h.db.games.countDocuments({ userId: "u_owner", gameId: "current" })).toBe(1);
  expect((await endpoint()).body.timings[0].medianSec).toBe(260);
});
test("bounded LRU expiry and global work admission use no persistent cache writes", async () => {
  let now = 10; const service = new BuildExecutionService(h.db, { perGame: h.services.perGame, builds: h.services.builds, customBuilds: h.services.customBuilds, now: () => now });
  for (let i = 0; i <= CACHE_LIMIT; i++) service.write(service.cache, String(i), { i }, CACHE_LIMIT);
  expect(service.cache.size).toBe(CACHE_LIMIT); expect(service.read(service.cache, "0")).toBeNull();
  now += TTL_MS; expect(service.read(service.cache, "1")).toBeNull(); expect(BASELINE_LIMIT).toBe(100);
  await seed(); for (let i = 0; i < MAX_WORK; i++) service.inflight.set(`held-${i}`, new Promise(() => {}));
  await expect(service.get("u_owner", "current")).rejects.toMatchObject({ status: 503, code: "build_execution_busy" });
});
