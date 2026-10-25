"use strict";
jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
const request = require("supertest");
const { createHarness } = require("./helpers/reviewsHarness");
const { validateCustomBuild } = require("../src/validation/customBuild");
const { CustomBuildsService } = require("../src/services/customBuilds");
/** @type {Awaited<ReturnType<typeof createHarness>>} */ let h;
const order = { v: 1, source: "game", sourceGameId: "private-replay-id", steps: [
  { t: null, supply: 14, action: "Unknown future action", note: "Shareable step note", supplyApprox: true },
  { t: 18, supply: 15, action: "BuildPylon" },
] };
beforeAll(async () => { h = await createHarness(); await h.seedUser("ref-owner"); }, 60_000);
afterAll(async () => { if (h) await h.close(); });

test("validates the optional reference field, retaining no giant unknown children", () => {
  const result = validateCustomBuild({ slug: "reference", name: "Reference", race: "Protoss", buildOrder: {
    ...order, unknown: "x".repeat(1000000), steps: order.steps.map(row => ({ ...row, unknown: { giant: "x".repeat(1000000) } })),
  } });
  expect(result.valid).toBe(true);
  if (!result.valid) throw new Error("invalid fixture");
  expect(/** @type {any} */ (result.value).buildOrder).toEqual(order);
  expect(validateCustomBuild({ slug: "bad", name: "Bad", race: "Protoss", buildOrder: { ...order, steps: Array(121).fill(order.steps[0]) } }).valid).toBe(false);
});

test("full owner detail retains reference provenance; lists and classification omit it", async () => {
  const saved = await request(h.app).put("/v1/custom-builds/reference").set("authorization", "Bearer u:ref-owner").send({ name: "Reference", race: "Protoss", buildOrder: order, rules: [], reclassify: false, createOnly: true });
  expect(saved.status).toBe(200);
  const own = await request(h.app).get("/v1/custom-builds/reference").set("authorization", "Bearer u:ref-owner");
  expect(own.status).toBe(200); expect(own.body.buildOrder).toEqual(order);
  const service = new CustomBuildsService(h.db, {});
  const list = (await service.list("u_ref-owner"))[0];
  expect(list).not.toHaveProperty("buildOrder"); expect(list).toHaveProperty("hasReferenceBuildOrder", true);
  expect((await service._classificationPage("u_ref-owner"))[0]).not.toHaveProperty("buildOrder");
  expect((await request(h.app).get("/v1/custom-builds/reference").set("authorization", "Bearer u:foreign")).status).toBe(404);
});

test("community detail projects shareable reference steps but never nested private replay IDs", async () => {
  await h.db.communityBuilds.insertOne({ slug: "public-reference", ownerUserId: "u_ref-owner", authorName: "", removed: false,
    title: "Reference", build: { name: "Reference", race: "Protoss", buildOrder: { ...order, privateSecret: "private-giant" }, notes: "personal-secret" } });
  const response = await request(h.app).get("/v1/community/builds/public-reference");
  expect(response.status).toBe(200);
  expect(response.body.build.buildOrder).toEqual({ v: 1, source: "game", steps: order.steps });
  expect(JSON.stringify(response.body)).not.toMatch(/private-replay|personal-secret|private-giant|sourceGameId/);
  const list = await request(h.app).get("/v1/community/builds");
  expect(list.status).toBe(200); expect(JSON.stringify(list.body)).not.toContain("buildOrder");
});

test("publication stores only the public reference leaves from the private saved build", async () => {
  const response = await request(h.app).post("/v1/community/builds").set("authorization", "Bearer u:ref-owner")
    .send({ slug: "reference", title: "Reference publication", publishAnonymously: true });
  expect(response.status).toBe(201);
  const row = await h.db.communityBuilds.findOne({ ownerUserId: "u_ref-owner", sourceSlug: "reference" });
  expect(row?.build.buildOrder).toEqual({ v: 1, source: "game", steps: order.steps });
  expect(JSON.stringify(row?.build)).not.toContain("private-replay-id");
});
