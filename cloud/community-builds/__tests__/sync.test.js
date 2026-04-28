"use strict";

const request = require("supertest");
const { bootTestEnv, sampleBuild, jsonBody } = require("./helpers/testEnv");

describe("incremental sync", () => {
  let env;
  let now;
  let clientId;
  beforeAll(async () => {
    now = 1_700_000_000_000;
    env = await bootTestEnv({ clock: () => now });
  });
  afterAll(async () => { await env.teardown(); });
  beforeEach(async () => {
    clientId = env.clientId();
    await env.db.builds.deleteMany({});
  });

  function postBuild(body) {
    const raw = jsonBody(body);
    return request(env.app)
      .post("/v1/community-builds/")
      .set("X-Client-Id", clientId)
      .set("X-Client-Signature", env.sign(raw))
      .set("Content-Type", "application/json")
      .send(raw);
  }

  test("sync since=0 returns all live builds and serverNow", async () => {
    await postBuild(sampleBuild());
    const res = await request(env.app).get("/v1/community-builds/sync?since=0");
    expect(res.status).toBe(200);
    expect(res.body.upserts.length).toBe(1);
    expect(res.body.deletes).toEqual([]);
    expect(res.body.serverNow).toBe(now);
  });

  test("sync returns deletes for soft-deleted builds since cutoff", async () => {
    await postBuild(sampleBuild());
    const cutoff = now - 1;
    now += 1000;
    await request(env.app)
      .delete("/v1/community-builds/proto-1-gate-expand")
      .set("X-Client-Id", clientId)
      .set("X-Client-Signature", env.sign(""));
    const res = await request(env.app).get(`/v1/community-builds/sync?since=${cutoff}`);
    expect(res.body.deletes).toEqual(["proto-1-gate-expand"]);
  });
});
