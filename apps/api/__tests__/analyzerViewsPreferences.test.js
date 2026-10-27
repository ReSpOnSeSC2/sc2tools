// @ts-nocheck
"use strict";

const request = require("supertest");
const { createHarness } = require("./helpers/reviewsHarness");
jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
let h;
const preference = "/v1/me/preferences/analyzerViews";
const view = (id = "ranked-pvz", name = "Ranked PvZ", filters = {}) => ({ id, name, filters: { preset: "last_30d", race: "P", opp_race: "Z", map_pool: "ladder", game_size: "1v1", ...filters }, section: "replays" });
const get = (who = "owner") => request(h.app).get(preference).set("authorization", h.bearer(who));
const put = (body, who = "owner") => request(h.app).put(preference).set("authorization", h.bearer(who)).send(body);
const defaultView = (who = "owner") => request(h.app).get("/v1/me/analyzer-default-view").set("authorization", h.bearer(who));
beforeAll(async () => { h = await createHarness(); await h.seedUser("owner"); await h.seedUser("other"); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { jest.restoreAllMocks(); await h.db.users.updateMany({}, { $unset: { preferences: "" } }); });

test("account cohorts persist in private saved/default views and an invalid complete write changes nothing", async () => {
  const accounts = Array.from({ length: 20 }, (_, n) => `2-S2-1-${n + 1000000000}`).join(",");
  const expected = accounts.split(",").sort().join(",");
  expect((await put({ views: [view("account", "Account", { accounts })], defaultViewId: "account" })).status).toBe(200);
  expect((await defaultView()).body.defaultView.filters.accounts).toBe(expected);
  for (const malformed of [".*", "2-S2-1-1,", Array(21).fill("2-S2-1-1").join(","), "2-S2-1-1,wrong-id"]) {
    expect((await put({ views: [view("bad", "Bad", { accounts: malformed })], defaultViewId: "bad" })).status).toBe(400);
    expect((await get()).body.views[0].filters.accounts).toBe(expected);
  }
  expect((await get("other")).body.views).toEqual([]);
});

test("fresh views are bounded empty defaults, and all new reads/writes are private no-store", async () => {
  const fresh = await get();
  expect(fresh.status).toBe(200); expect(fresh.body).toEqual({ views: [], defaultViewId: null });
  expect(fresh.headers["cache-control"]).toBe("private, no-store");
  const saved = await put({ views: [view()], defaultViewId: "ranked-pvz" });
  expect(saved.status).toBe(200); expect(saved.headers["cache-control"]).toBe("private, no-store");
  const selected = await defaultView();
  expect(selected.headers["cache-control"]).toBe("private, no-store");
  expect(selected.body).toEqual({ defaultView: view(), defaultTab: null });
});

test("owner-scoped views replace atomically without touching misc or other preference types", async () => {
  await h.db.users.updateOne({ userId: "u_owner" }, { $set: { preferences: { misc: { defaultTab: "macro", volume: 0.7 }, arcade: { minerals: 10 } } } });
  await put({ views: [view()], defaultViewId: "ranked-pvz", userId: "u_other" });
  expect((await get("other")).body).toEqual({ views: [], defaultViewId: null });
  expect((await defaultView("other")).body).toEqual({ defaultView: null, defaultTab: null });
  const stored = await h.db.users.findOne({ userId: "u_owner" });
  expect(stored.preferences.misc).toEqual({ defaultTab: "macro", volume: 0.7 });
  expect(stored.preferences.arcade).toEqual({ minerals: 10 });
  expect((await defaultView()).body.defaultTab).toBe("macro");
  const replacement = await put({ views: [view("renamed", "Renamed")], defaultViewId: null });
  expect(replacement.body.views).toHaveLength(1); expect(replacement.body.views[0].id).toBe("renamed");
  expect((await defaultView()).body).toEqual({ defaultView: null, defaultTab: "macro" });
});

test("unknown fields and drill/credential keys cannot be stored or returned", async () => {
  const raw = { views: [{ ...view(), secret: "private-view-extra", filters: { ...view().filters, regions: "kr,EU,invalid,EU", token: "secret-token", userId: "u_other", opponent: "private-opponent", page: 9, cursor: "opaque" } }],
    defaultViewId: "ranked-pvz", owner: "u_other", secret: "private-top-extra" };
  const response = await put(raw);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ views: [view("ranked-pvz", "Ranked PvZ", { regions: "EU,KR" })], defaultViewId: "ranked-pvz" });
  expect(JSON.stringify((await get()).body)).not.toMatch(/secret|private-opponent|u_other|opaque|cursor|page/);
});

test("sanitized GET skips corrupt rows and clears dangling defaults without mutating stored preferences", async () => {
  const raw = { views: [view(), { ...view("duplicate", "RANKED PVZ") }, { id: "bad!", name: "Invalid", filters: {} },
    view("bad-cohort", "Bad cohort", { map_exact: "[broken" }), { ...view("extra", "Extra"), secret: "hidden" }], defaultViewId: "bad-cohort", secret: "never-return" };
  await h.db.users.updateOne({ userId: "u_owner" }, { $set: { "preferences.analyzerViews": raw } });
  const response = await get();
  expect(response.body).toEqual({ views: [view(), view("extra", "Extra")], defaultViewId: null });
  expect((await defaultView()).body.defaultView).toBeNull();
  const stored = await h.db.users.findOne({ userId: "u_owner" }); expect(stored.preferences.analyzerViews).toEqual(raw);
});

test.each([
  { views: Array.from({ length: 13 }, (_, i) => view(`id-${i}`, `Name ${i}`)) },
  { views: [view(), view()] },
  { views: [view(), view("second", "RANKED PVZ")] },
  { views: [view("bad.id")] },
  { views: [view("valid", "x".repeat(61))] },
  { views: [view("valid", "\u0000bad")] },
  { views: [{ ...view(), section: "admin" }] },
  { views: [{ ...view(), filters: [] }] },
  { views: "invalid" },
  { views: [view()], defaultViewId: "missing" },
])("strict PUT rejects ambiguous or invalid view sets without replacing the previous value: %j", async (invalid) => {
  const original = { views: [view()], defaultViewId: "ranked-pvz" };
  await put(original);
  const response = await put(invalid);
  expect(response.status).toBe(400); expect(response.body.error.code).toBe("invalid_analyzer_views");
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect((await get()).body).toEqual(original);
});

test("exactly12 views are accepted and deleting the selected view returns to the legacy default", async () => {
  await h.db.users.updateOne({ userId: "u_owner" }, { $set: { "preferences.misc": { defaultTab: "builds" } } });
  const views = Array.from({ length: 12 }, (_, i) => view(`id-${i}`, `Name ${i}`));
  expect((await put({ views, defaultViewId: "id-4" })).status).toBe(200);
  expect((await defaultView()).body).toEqual({ defaultView: views[4], defaultTab: "builds" });
  expect((await put({ views: [], defaultViewId: null })).status).toBe(200);
  expect((await defaultView()).body).toEqual({ defaultView: null, defaultTab: "builds" });
});

test.each(["not-json", "[]", '[" "]', '["Alpha",null]', JSON.stringify(Array.from({ length: 17 }, (_, i) => `Map ${i}`)), JSON.stringify(["x".repeat(201)])])("malformed exact alias cohorts fail the complete write: %s", async (map_exact) => {
  const response = await put({ views: [view("exact", "Exact map", { map: "Alpha", map_exact })], defaultViewId: "exact" });
  expect(response.status).toBe(400); expect(response.body.error.code).toBe("invalid_analyzer_views");
  expect((await get()).body).toEqual({ views: [], defaultViewId: null });
});

test("an exact alias cohort survives storage and the default response without broadening", async () => {
  const exact = view("exact", "Exact map", { map: "Alpha LE", map_exact: JSON.stringify(["Alpha LE", "Alpha"]) });
  expect((await put({ views: [exact], defaultViewId: "exact" })).body.views).toEqual([exact]);
  expect((await defaultView()).body.defaultView).toEqual(exact);
});

test("a mismatched visible map is normalized to its exact cohort in stored/default views", async () => {
  const raw = view("exact", "Exact map", { map: "Wrong visible map", map_exact: JSON.stringify(["Alpha LE", "Alpha"]) });
  const expected = view("exact", "Exact map", { map: "Alpha LE", map_exact: JSON.stringify(["Alpha LE", "Alpha"]) });
  const response = await put({ views: [raw], defaultViewId: "exact" });
  expect(response.status).toBe(200); expect(response.body.views).toEqual([expected]);
  expect((await defaultView()).body.defaultView).toEqual(expected);
});

test("custom date bounds normalize once and service callers cannot bypass strict write validation", async () => {
  const raw = view("dates", "Custom dates", { preset: "custom", since: "2026-10-20", until: "2026-10-01" });
  const response = await put({ views: [raw], defaultViewId: "dates" });
  expect(response.status).toBe(200);
  expect(response.body.views[0].filters).toMatchObject({ preset: "custom", since: "2026-10-01T00:00:00.000Z", until: "2026-10-20T00:00:00.000Z" });
  await expect(h.services.users.updatePreferences("u_owner", "analyzerViews", { views: [raw], defaultViewId: "missing" })).rejects.toMatchObject({ status: 400, code: "invalid_analyzer_views" });
  expect((await get()).body).toEqual(response.body);
});

test("default resolution performs one projected indexed user read and no game work", async () => {
  await put({ views: [view()], defaultViewId: "ranked-pvz" });
  const read = jest.spyOn(h.db.users, "findOne");
  const preferenceRead = jest.spyOn(h.services.users, "getPreferences");
  const aggregate = jest.spyOn(h.db.games, "aggregate"), find = jest.spyOn(h.db.games, "find"), findOne = jest.spyOn(h.db.games, "findOne");
  const response = await defaultView(); expect(response.status).toBe(200);
  const selected = read.mock.calls.filter(([, opts]) => opts?.projection?.["preferences.analyzerViews"]);
  expect(selected).toEqual([[{ userId: "u_owner" }, { projection: { _id: 0, "preferences.misc": 1, "preferences.analyzerViews": 1 } }]]);
  expect(preferenceRead).not.toHaveBeenCalled(); expect(aggregate).not.toHaveBeenCalled(); expect(find).not.toHaveBeenCalled(); expect(findOne).not.toHaveBeenCalled();
});

test("authentication is required and malformed legacy defaults cannot leak arbitrary misc data", async () => {
  expect((await request(h.app).get(preference)).status).toBe(401);
  expect((await request(h.app).put(preference).send({ views: [] })).status).toBe(401);
  expect((await request(h.app).get("/v1/me/analyzer-default-view")).status).toBe(401);
  await h.db.users.updateOne({ userId: "u_owner" }, { $set: { "preferences.misc": { defaultTab: { secret: "private" }, token: "private" } } });
  expect((await defaultView()).body).toEqual({ defaultView: null, defaultTab: null });
});

const PATCH_IDS = ["saved-patch-eight", "saved-patch-twelve", "saved-patch-outside", "saved-patch-foreign"];
const PATCH_SINCE = "2026-10-01T00:00:00.000Z", PATCH_UNTIL = "2026-10-27T23:59:59.999Z";
function patchView(era) { return view(`patch-${era}`, `Frozen patch ${era}`, { preset: "custom", since: PATCH_SINCE, until: PATCH_UNTIL, patch_era: era }); }
async function seedPatchCohort(era) {
  const own = { userId: h.userId("owner"), date: new Date("2026-10-25T12:00:00.000Z"), result: "Victory", myRace: "Protoss",
    opponent: { race: "Zerg" }, isLadderGame: true, playerCount: 2, matchFormat: "1v1", durationSec: 600 };
  const selectedVersion = era === "before" ? "5.0.16.97425" : "5.0.17.99999";
  await h.db.games.insertMany([
    { ...own, gameId: PATCH_IDS[0], gameVersion: "5.0.16.97425" },
    { ...own, gameId: PATCH_IDS[1], gameVersion: "5.0.17.99999" },
    { ...own, gameId: PATCH_IDS[2], gameVersion: selectedVersion, date: new Date("2026-09-01T12:00:00.000Z") },
    { ...own, userId: h.userId("other"), gameId: PATCH_IDS[3], gameVersion: selectedVersion },
  ]);
}
async function clearPatchCohort() { await h.db.games.deleteMany({ userId: { $in: [h.userId("owner"), h.userId("other")] }, gameId: { $in: PATCH_IDS } }); }
const summaryFor = filters => request(h.app).get(`/v1/summary?${new URLSearchParams(Object.entries(filters).map(([key, value]) => [key, String(value)]))}`).set("authorization", h.bearer("owner"));

test.each(["before", "after"])("custom %s date/version cohort survives save, storage, GET and selected default", async era => {
  const selected = patchView(era), body = { views: [selected], defaultViewId: selected.id };
  try {
    await seedPatchCohort(era);
    const saved = await put(body);
    expect(saved.status).toBe(200); expect(saved.body).toEqual(body);
    expect((await get()).body).toEqual(body);
    const resolved = await defaultView();
    expect(resolved.status).toBe(200); expect(resolved.body.defaultView).toEqual(selected);
    const stored = await h.db.users.findOne({ userId: h.userId("owner") });
    expect(stored.preferences.analyzerViews).toEqual(body);
    expect((await get("other")).body).toEqual({ views: [], defaultViewId: null });
    const scoped = await summaryFor(resolved.body.defaultView.filters);
    expect(scoped.status).toBe(200); expect(scoped.body.totals.total).toBe(1);
    expect(scoped.body.recent.map(row => row.gameId)).toEqual([era === "before" ? PATCH_IDS[0] : PATCH_IDS[1]]);
    // The same persisted dates alone include both release strings. Losing the
    // era is a real cohort expansion, not just a missing preference property.
    const datesOnly = { ...resolved.body.defaultView.filters }; delete datesOnly.patch_era;
    const broadened = await summaryFor(datesOnly);
    expect(broadened.status).toBe(200); expect(broadened.body.totals.total).toBe(2);
    expect(broadened.body.recent.map(row => row.gameId).sort()).toEqual(PATCH_IDS.slice(0, 2).sort());
  } finally { await clearPatchCohort(); }
});

test.each(["future-era", ["before"], { $ne: "after" }, null])("invalid patch era is dropped without losing the valid custom dates: %j", async patch_era => {
  const selected = patchView("before"), raw = { ...selected, filters: { ...selected.filters, patch_era } };
  const expected = { ...selected, filters: { ...selected.filters } }; delete expected.filters.patch_era;
  const saved = await put({ views: [raw], defaultViewId: selected.id });
  expect(saved.status).toBe(200);
  expect(saved.body).toEqual({ views: [expected], defaultViewId: selected.id });
  expect((await get()).body).toEqual(saved.body);
  expect((await defaultView()).body.defaultView).toEqual(expected);
});

test.each(["all", "current_season", "after_5_0_17"])("noncustom %s owns its era/date rule instead of saving an explicit stale override", async preset => {
  const raw = view("preset-era", "Preset era", { preset, since: PATCH_SINCE, until: PATCH_UNTIL, patch_era: "before" });
  const expected = view("preset-era", "Preset era", { preset });
  const saved = await put({ views: [raw], defaultViewId: raw.id });
  expect(saved.status).toBe(200);
  expect(saved.body).toEqual({ views: [expected], defaultViewId: expected.id });
  expect((await get()).body).toEqual(saved.body);
  expect((await defaultView()).body.defaultView).toEqual(expected);
});

test("stored legacy era values sanitize on reads without rewriting preferences", async () => {
  const valid = patchView("after"), invalid = view("invalid-era", "Invalid era", { preset: "custom", patch_era: "future-era" });
  const irrelevant = view("preset-era", "Preset era", { preset: "all", patch_era: "before", since: PATCH_SINCE });
  const raw = { views: [valid, invalid, irrelevant], defaultViewId: valid.id };
  await h.db.users.updateOne({ userId: h.userId("owner") }, { $set: { "preferences.analyzerViews": raw } });
  const response = await get();
  expect(response.status).toBe(200); expect(response.body.views[0]).toEqual(valid);
  expect(response.body.views[1].filters).not.toHaveProperty("patch_era");
  expect(response.body.views[2].filters).not.toHaveProperty("patch_era");
  expect(response.body.views[2].filters).not.toHaveProperty("since");
  expect((await defaultView()).body.defaultView).toEqual(valid);
  expect((await h.db.users.findOne({ userId: h.userId("owner") })).preferences.analyzerViews).toEqual(raw);
});
function savedSessionView() { return { ...patchView("before"), id: "session-cohort", name: "Session cohort", section: "sessions" }; }

test("Sessions saved/default views preserve only their owner cohort and literal list destination", async () => {
  const selected = savedSessionView();
  const raw = { ...selected, sessionId: "private-session-report", pathname: "/app/sessions/private-session-report",
    filters: { ...selected.filters, id: "private-session-report", sessionId: "private-session-report", before: "private-session-cursor", gamesBefore: "private-game-cursor",
      day: "2026-10-25", windowFrom: PATCH_SINCE, windowTo: PATCH_UNTIL, contextDays: 30, token: "private-credential" } };
  const saved = await put({ views: [raw], defaultViewId: selected.id });
  expect(saved.status).toBe(200);
  expect(saved.body).toEqual({ views: [selected], defaultViewId: selected.id });
  const aggregate = jest.spyOn(h.db.games, "aggregate"), find = jest.spyOn(h.db.games, "find"), findOne = jest.spyOn(h.db.games, "findOne");
  expect((await get()).body).toEqual(saved.body);
  expect((await defaultView()).body.defaultView).toEqual(selected);
  expect((await get("other")).body).toEqual({ views: [], defaultViewId: null });
  expect((await defaultView("other")).body.defaultView).toBeNull();
  const stored = await h.db.users.findOne({ userId: h.userId("owner") });
  expect(stored.preferences.analyzerViews).toEqual(saved.body);
  expect(JSON.stringify(saved.body)).not.toMatch(/private-session|private-game|private-credential|windowFrom|windowTo|contextDays|gamesBefore/);
  expect(aggregate).not.toHaveBeenCalled(); expect(find).not.toHaveBeenCalled(); expect(findOne).not.toHaveBeenCalled();
});

test.each(["sessions/private-report", "sessions/:id"])("a saved view cannot turn the literal Sessions destination into %s", async section => {
  const selected = savedSessionView(), body = { views: [selected], defaultViewId: selected.id };
  expect((await put(body)).status).toBe(200);
  const rejected = await put({ views: [{ ...selected, section }], defaultViewId: selected.id });
  expect(rejected.status).toBe(400); expect(rejected.body.error.code).toBe("invalid_analyzer_views");
  expect((await get()).body).toEqual(body);
  expect((await defaultView()).body.defaultView).toEqual(selected);
});

test("legacy stored Sessions cohort resolves on read without inventing report authority or rewriting storage", async () => {
  const selected = savedSessionView(), raw = { views: [selected], defaultViewId: selected.id };
  await h.db.users.updateOne({ userId: h.userId("owner") }, { $set: { "preferences.analyzerViews": raw } });
  expect((await get()).body).toEqual(raw);
  expect((await defaultView()).body).toEqual({ defaultView: selected, defaultTab: null });
  expect((await h.db.users.findOne({ userId: h.userId("owner") })).preferences.analyzerViews).toEqual(raw);
});