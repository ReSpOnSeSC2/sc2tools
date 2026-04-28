"use strict";

const request = require("supertest");
const { bootTestEnv, sampleBuild, jsonBody } = require("./helpers/testEnv");

describe("votes + flags", () => {
  let env;
  let author;
  beforeAll(async () => { env = await bootTestEnv(); });
  afterAll(async () => { await env.teardown(); });
  beforeEach(async () => {
    author = env.clientId();
    await env.db.builds.deleteMany({});
    await env.db.votes.deleteMany({});
    await env.db.flags.deleteMany({});
    const raw = jsonBody(sampleBuild());
    await request(env.app)
      .post("/v1/community-builds/")
      .set("X-Client-Id", author)
      .set("X-Client-Signature", env.sign(raw))
      .set("Content-Type", "application/json")
      .send(raw);
  });

  function vote(value, cid) {
    const raw = jsonBody({ vote: value });
    return request(env.app)
      .post("/v1/community-builds/proto-1-gate-expand/vote")
      .set("X-Client-Id", cid)
      .set("X-Client-Signature", env.sign(raw))
      .set("Content-Type", "application/json")
      .send(raw);
  }

  test("upvote increments upvotes once per client", async () => {
    const voter = env.clientId();
    const first = await vote(1, voter);
    expect(first.status).toBe(200);
    expect(first.body.upvotes).toBe(1);
    const repeat = await vote(1, voter);
    expect(repeat.body.upvotes).toBe(1);
  });

  test("changing vote flips totals correctly", async () => {
    const voter = env.clientId();
    await vote(1, voter);
    const flipped = await vote(-1, voter);
    expect(flipped.body.upvotes).toBe(0);
    expect(flipped.body.downvotes).toBe(1);
  });

  test("vote rejects invalid value", async () => {
    const voter = env.clientId();
    const raw = jsonBody({ vote: 5 });
    const res = await request(env.app)
      .post("/v1/community-builds/proto-1-gate-expand/vote")
      .set("X-Client-Id", voter)
      .set("X-Client-Signature", env.sign(raw))
      .set("Content-Type", "application/json")
      .send(raw);
    expect(res.status).toBe(400);
  });

  test("flag is idempotent per client and bumps counter once", async () => {
    const flagger = env.clientId();
    const raw = jsonBody({ reason: "spam" });
    const url = "/v1/community-builds/proto-1-gate-expand/flag";
    const first = await request(env.app)
      .post(url)
      .set("X-Client-Id", flagger)
      .set("X-Client-Signature", env.sign(raw))
      .set("Content-Type", "application/json")
      .send(raw);
    expect(first.status).toBe(200);
    expect(first.body.flagged).toBe(1);
    const repeat = await request(env.app)
      .post(url)
      .set("X-Client-Id", flagger)
      .set("X-Client-Signature", env.sign(raw))
      .set("Content-Type", "application/json")
      .send(raw);
    expect(repeat.body.flagged).toBe(1);
  });
});
