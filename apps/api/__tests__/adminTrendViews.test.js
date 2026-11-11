// @ts-nocheck
"use strict";

const request = require("supertest");
const { createHarness } = require("./helpers/reviewsHarness");
jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const path = "/v1/me/preferences/adminTrendViews";
const population = { excludedRaces: ["R"], selection: "include", playerIds: [`p_${"a".repeat(22)}`],
  mmrMin: "4000", mmrMax: "", includeUnrated: false };
const view = { id: "saved", name: "Saved cohort", filters: { preset: "all", map: "Test Arena" }, population };
let h;
const get = who => request(h.app).get(path).set("authorization", h.bearer(who));
const put = (who, body) => request(h.app).put(path).set("authorization", h.bearer(who)).send(body);
beforeAll(async () => {
  h = await createHarness({ admins: ["admin", "other"] });
  for (const who of ["admin", "other", "member"]) await h.seedUser(who);
});
afterAll(async () => { await h?.close(); });

test("private admin preferences reject raw IDs and CAS exact owner revision", async () => {
  expect((await get("member").expect(403)).headers["cache-control"]).toBe("private, no-store");
  await put("member", { revision: 0, views: [view] }).expect(403);
  expect((await get("admin").expect(200)).body).toEqual({ revision: 0, views: [] });
  await put("admin", { revision: 0, views: [{ ...view, filters: { accounts: "1-S2-1-111" } }] }).expect(400);
  await put("admin", { revision: 0, views: [{ ...view, population: { ...population, playerIds: ["user:private"] } }] }).expect(400);
  await put("admin", { revision: 0, views: [view, { ...view, id: "duplicate", name: "SAVED COHORT" }] }).expect(400);

  const changes = await Promise.all([
    put("admin", { revision: 0, views: [view], userId: h.userId("other") }),
    put("admin", { revision: 0, views: [{ ...view, name: "New cohort" }] }),
  ]);
  expect(changes.map(result => result.status).sort()).toEqual([200, 409]);
  const winner = changes.find(result => result.status === 200);
  expect(winner.headers["cache-control"]).toBe("private, no-store");
  expect(winner.body).toMatchObject({ revision: 1, views: [{ id: "saved", population }] });
  expect((await get("other").expect(200)).body).toEqual({ revision: 0, views: [] });
  expect((await get("admin").expect(200)).body).toEqual(winner.body);
  expect((await put("admin", { revision: 1, views: [] }).expect(200)).body).toEqual({ revision: 2, views: [] });
});
