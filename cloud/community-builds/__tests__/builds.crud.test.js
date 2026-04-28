"use strict";

const request = require("supertest");
const { bootTestEnv, sampleBuild, jsonBody } = require("./helpers/testEnv");

describe("builds CRUD", () => {
  let env;
  let clientId;
  beforeAll(async () => { env = await bootTestEnv(); });
  afterAll(async () => { await env.teardown(); });
  beforeEach(async () => {
    clientId = env.clientId();
    await env.db.builds.deleteMany({});
    await env.db.votes.deleteMany({});
    await env.db.flags.deleteMany({});
  });

  function postBuild(body, cid = clientId) {
    const raw = jsonBody(body);
    return request(env.app)
      .post("/v1/community-builds/")
      .set("X-Client-Id", cid)
      .set("X-Client-Signature", env.sign(raw))
      .set("Content-Type", "application/json")
      .send(raw);
  }

  test("POST creates a build and returns 201 with public fields", async () => {
    const res = await postBuild(sampleBuild());
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("proto-1-gate-expand");
    expect(res.body.authorClientId).toBe(clientId);
    expect(res.body.upvotes).toBe(0);
    expect(res.body.flagged).toBe(0);
    expect(res.body.version).toBe(1);
  });

  test("POST rejects duplicate id with 409", async () => {
    await postBuild(sampleBuild());
    const res = await postBuild(sampleBuild());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("build_exists");
  });

  test("POST rejects bad payload with 400 + validation details", async () => {
    const bad = { ...sampleBuild(), race: "Orc" };
    const res = await postBuild(bad);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation");
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  test("POST rejects bad signature with 401", async () => {
    const res = await request(env.app)
      .post("/v1/community-builds/")
      .set("X-Client-Id", clientId)
      .set("X-Client-Signature", "0".repeat(64))
      .set("Content-Type", "application/json")
      .send(jsonBody(sampleBuild()));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("bad_signature");
  });

  test("POST rejects missing client id with 401", async () => {
    const res = await request(env.app)
      .post("/v1/community-builds/")
      .set("Content-Type", "application/json")
      .send(jsonBody(sampleBuild()));
    expect(res.status).toBe(401);
  });

  test("GET /:id returns build", async () => {
    await postBuild(sampleBuild());
    const res = await request(env.app).get("/v1/community-builds/proto-1-gate-expand");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("proto-1-gate-expand");
  });

  test("GET /:id returns 404 when missing", async () => {
    const res = await request(env.app).get("/v1/community-builds/does-not-exist");
    expect(res.status).toBe(404);
  });

  test("GET /:id rejects bad id format", async () => {
    const res = await request(env.app).get("/v1/community-builds/Bad ID!!");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_id");
  });

  test("PUT replaces own build, bumps version, preserves createdAt", async () => {
    const created = await postBuild(sampleBuild());
    const next = { ...sampleBuild(), name: "1 Gate Expand v2" };
    const raw = jsonBody(next);
    const res = await request(env.app)
      .put("/v1/community-builds/proto-1-gate-expand")
      .set("X-Client-Id", clientId)
      .set("X-Client-Signature", env.sign(raw))
      .set("Content-Type", "application/json")
      .send(raw);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("1 Gate Expand v2");
    expect(res.body.version).toBe(2);
    expect(res.body.createdAt).toBe(created.body.createdAt);
  });

  test("PUT rejects when client is not author", async () => {
    await postBuild(sampleBuild());
    const next = { ...sampleBuild(), name: "stolen" };
    const stranger = env.clientId();
    const raw = jsonBody(next);
    const res = await request(env.app)
      .put("/v1/community-builds/proto-1-gate-expand")
      .set("X-Client-Id", stranger)
      .set("X-Client-Signature", env.sign(raw))
      .set("Content-Type", "application/json")
      .send(raw);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_author");
  });

  test("DELETE soft-deletes own build, hides from list and get", async () => {
    await postBuild(sampleBuild());
    const del = await request(env.app)
      .delete("/v1/community-builds/proto-1-gate-expand")
      .set("X-Client-Id", clientId)
      .set("X-Client-Signature", env.sign(""));
    expect(del.status).toBe(204);
    const get = await request(env.app).get("/v1/community-builds/proto-1-gate-expand");
    expect(get.status).toBe(404);
  });
});
