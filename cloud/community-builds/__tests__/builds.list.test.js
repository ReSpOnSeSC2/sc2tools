"use strict";

const request = require("supertest");
const { bootTestEnv, sampleBuild, jsonBody } = require("./helpers/testEnv");

describe("builds list + filter + sort", () => {
  let env;
  let clientId;
  beforeAll(async () => { env = await bootTestEnv(); });
  afterAll(async () => { await env.teardown(); });
  beforeEach(async () => {
    clientId = env.clientId();
    await env.db.builds.deleteMany({});
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

  test("filters by race/vsRace", async () => {
    await postBuild(sampleBuild());
    await postBuild(sampleBuild({ id: "zerg-12-pool", race: "Zerg", vsRace: "Protoss" }));
    const res = await request(env.app).get("/v1/community-builds/?race=Zerg&vsRace=Protoss");
    expect(res.status).toBe(200);
    expect(res.body.builds.length).toBe(1);
    expect(res.body.builds[0].id).toBe("zerg-12-pool");
  });

  test("filters by free-text q (case-insensitive substring)", async () => {
    await postBuild(sampleBuild());
    await postBuild(sampleBuild({ id: "proto-blink-allin", name: "Blink Stalker All-in" }));
    const res = await request(env.app).get("/v1/community-builds/?q=blink");
    expect(res.status).toBe(200);
    expect(res.body.builds.map((b) => b.id)).toEqual(["proto-blink-allin"]);
  });

  test("hides flagged builds above threshold from list and getById", async () => {
    await postBuild(sampleBuild());
    await env.db.builds.updateOne(
      { id: "proto-1-gate-expand" },
      { $set: { flagged: 6 } },
    );
    const list = await request(env.app).get("/v1/community-builds/");
    expect(list.body.builds.length).toBe(0);
    const single = await request(env.app).get("/v1/community-builds/proto-1-gate-expand");
    expect(single.status).toBe(404);
  });

  test("paginates with cursor", async () => {
    for (let i = 0; i < 3; i += 1) {
      await postBuild(sampleBuild({ id: `proto-build-${i}`, name: `Build ${i}` }));
    }
    const first = await request(env.app).get("/v1/community-builds/?limit=2");
    expect(first.body.builds.length).toBe(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await request(env.app)
      .get(`/v1/community-builds/?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.builds.length).toBe(1);
  });
});
