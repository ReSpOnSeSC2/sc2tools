"use strict";

const request = require("supertest");
const { bootTestEnv } = require("./helpers/testEnv");

describe("health + handshake", () => {
  let env;
  beforeAll(async () => { env = await bootTestEnv(); });
  afterAll(async () => { await env.teardown(); });

  test("GET /v1/community-builds/health returns 200 with service identity", async () => {
    const res = await request(env.app).get("/v1/community-builds/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe("sc2-community-builds");
  });

  test("GET /v1/community-builds/handshake returns hex pepper", async () => {
    const res = await request(env.app).get("/v1/community-builds/handshake");
    expect(res.status).toBe(200);
    expect(res.body.algorithm).toBe("HMAC-SHA256");
    expect(res.body.pepperHex).toMatch(/^[0-9a-f]{64}$/);
  });
});
