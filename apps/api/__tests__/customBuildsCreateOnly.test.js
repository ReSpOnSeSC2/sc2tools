// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * ``PUT /v1/custom-builds/:slug`` with ``createOnly: true`` (the "Add new
 * build" editor in the build check-in): a save that would overwrite a live
 * build, or revive a soft-deleted one, answers 409 ``slug_taken`` instead.
 * Without the flag the route keeps its upsert behaviour. Full app, real
 * Mongo.
 */

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const request = require("supertest");
const { startFullApp, signIn } = require("./helpers/buildIntentHarness");

describe("PUT /v1/custom-builds/:slug createOnly", () => {
  let h;
  let userCounter = 0;

  beforeAll(async () => {
    h = await startFullApp("custom_builds_create_only_test");
  });

  afterAll(async () => {
    if (h) await h.stop();
  });

  async function newUser() {
    userCounter += 1;
    return signIn(h.app, h.db, `create${userCounter}`);
  }

  function save(user, slug, body) {
    return request(h.app)
      .put(`/v1/custom-builds/${slug}`)
      .set("authorization", user.web)
      .send({ race: "Protoss", vsRace: "Zerg", reclassify: false, ...body });
  }

  const stored = (user, slug) => h.db.customBuilds.findOne({ userId: user.userId, slug });

  test("creates a new build and refuses a second create of the same slug", async () => {
    const user = await newUser();
    const created = await save(user, "dt-rush", { name: "DT Rush", createOnly: true }).expect(200);
    expect(created.body).toEqual(expect.objectContaining({ ok: true, saved: true }));
    const doc = await stored(user, "dt-rush");
    expect(doc.name).toBe("DT Rush");
    expect(doc).not.toHaveProperty("createOnly");

    const taken = await save(user, "dt-rush", { name: "DT Rush v2", createOnly: true }).expect(409);
    expect(taken.body).toEqual({
      error: { code: "slug_taken", message: "You already have a build with this name." },
    });
    expect((await stored(user, "dt-rush")).name).toBe("DT Rush");
  });

  test("never revives a soft-deleted build", async () => {
    const user = await newUser();
    await save(user, "old-build", { name: "Old Build" }).expect(200);
    await request(h.app).delete("/v1/custom-builds/old-build").set("authorization", user.web).expect(204);
    const taken = await save(user, "old-build", { name: "Old Build", createOnly: true }).expect(409);
    expect(taken.body.error.code).toBe("slug_taken");
    const doc = await stored(user, "old-build");
    expect(doc.deletedAt).toEqual(expect.any(Date));
    await request(h.app).get("/v1/custom-builds/old-build").set("authorization", user.web).expect(404);
  });

  test("without the flag the save still upserts, and revives a deleted build", async () => {
    const user = await newUser();
    await save(user, "kept", { name: "Kept" }).expect(200);
    await save(user, "kept", { name: "Kept, edited" }).expect(200);
    expect((await stored(user, "kept")).name).toBe("Kept, edited");
    await save(user, "kept", { name: "Kept, again", createOnly: false }).expect(200);
    expect((await stored(user, "kept")).name).toBe("Kept, again");
    await request(h.app).delete("/v1/custom-builds/kept").set("authorization", user.web).expect(204);
    await save(user, "kept", { name: "Kept, back" }).expect(200);
    const doc = await stored(user, "kept");
    expect(doc).not.toHaveProperty("deletedAt");
    expect(doc).not.toHaveProperty("createOnly");
  });

  test("the flag is stripped before validation and slugs are per user", async () => {
    const owner = await newUser();
    const other = await newUser();
    await save(owner, "shared-name", { name: "Shared", createOnly: true }).expect(200);
    await save(other, "shared-name", { name: "Shared", createOnly: true }).expect(200);
    const invalid = await save(owner, "bad-one", { name: "", createOnly: true }).expect(400);
    expect(invalid.body.error.code).toBe("bad_request");
    expect(await stored(owner, "bad-one")).toBeNull();
  });
});
