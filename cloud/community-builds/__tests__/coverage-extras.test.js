"use strict";

const request = require("supertest");
const { createLogger } = require("../src/logger");
const { toPublic, clampPageSize } = require("../src/services/buildSerialiser");
const { encodeCursor } = require("../src/util/cursor");
const { buildErrorHandler } = require("../src/middleware/errorHandler");
const express = require("express");
const { bootTestEnv, sampleBuild, jsonBody } = require("./helpers/testEnv");

describe("logger", () => {
  test("createLogger returns a usable logger in dev mode", () => {
    const log = createLogger({ level: "warn", nodeEnv: "development" });
    expect(typeof log.info).toBe("function");
    log.warn({ tag: "x" }, "ok");
  });

  test("createLogger returns a usable logger in production mode", () => {
    const log = createLogger({ level: "info", nodeEnv: "production" });
    expect(typeof log.info).toBe("function");
  });
});

describe("buildSerialiser", () => {
  test("toPublic returns null for null input", () => {
    expect(toPublic(null)).toBeNull();
  });

  test("toPublic strips the _id field", () => {
    const r = toPublic({ _id: "x", id: "y", upvotes: 0 });
    expect(r).toEqual({ id: "y", upvotes: 0 });
  });

  test("clampPageSize falls back to default for garbage", () => {
    expect(clampPageSize("abc")).toBe(50);
    expect(clampPageSize("-1")).toBe(50);
    expect(clampPageSize("9999")).toBe(100);
    expect(clampPageSize("25")).toBe(25);
  });
});

describe("cursor", () => {
  test("encodeCursor returns null for null input", () => {
    expect(encodeCursor(null)).toBeNull();
  });
});

describe("error handler", () => {
  test("translates a 500 error to internal_error JSON", async () => {
    const app = express();
    app.get("/boom", (_req, _res, next) => next(new Error("boom")));
    const log = createLogger({ level: "silent" });
    app.use((req, _res, next) => { req.id = "req-test"; next(); });
    app.use(buildErrorHandler(log));
    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
  });

  test("respects err.status and err.code when provided", async () => {
    const app = express();
    app.get("/teapot", (_req, _res, next) => {
      const e = new Error("nope");
      e.status = 418;
      e.code = "i_am_a_teapot";
      next(e);
    });
    const log = createLogger({ level: "silent" });
    app.use((req, _res, next) => { req.id = "req-test"; next(); });
    app.use(buildErrorHandler(log));
    const res = await request(app).get("/teapot");
    expect(res.status).toBe(418);
    expect(res.body.error).toBe("i_am_a_teapot");
  });
});

describe("requestId middleware (incoming header path)", () => {
  test("propagates a safe X-Request-Id from the client", async () => {
    const env = await bootTestEnv();
    const res = await request(env.app)
      .get("/v1/community-builds/health")
      .set("X-Request-Id", "abc-123");
    expect(res.headers["x-request-id"]).toBe("abc-123");
    await env.teardown();
  });
});

describe("more service edge cases", () => {
  let env;
  let cid;
  beforeAll(async () => { env = await bootTestEnv(); });
  afterAll(async () => { await env.teardown(); });
  beforeEach(async () => {
    cid = env.clientId();
    await env.db.builds.deleteMany({});
  });

  function postBuild(body) {
    const raw = jsonBody(body);
    return request(env.app)
      .post("/v1/community-builds/")
      .set("X-Client-Id", cid)
      .set("X-Client-Signature", env.sign(raw))
      .set("Content-Type", "application/json")
      .send(raw);
  }

  test("PUT rejects when path id != body id", async () => {
    await postBuild(sampleBuild());
    const next = sampleBuild({ id: "different-id" });
    const raw = jsonBody(next);
    const res = await request(env.app)
      .put("/v1/community-builds/proto-1-gate-expand")
      .set("X-Client-Id", cid)
      .set("X-Client-Signature", env.sign(raw))
      .set("Content-Type", "application/json")
      .send(raw);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("id_mismatch");
  });

  test("PUT 404 when build does not exist", async () => {
    const body = sampleBuild({ id: "ghost-build" });
    const raw = jsonBody(body);
    const res = await request(env.app)
      .put("/v1/community-builds/ghost-build")
      .set("X-Client-Id", cid)
      .set("X-Client-Signature", env.sign(raw))
      .set("Content-Type", "application/json")
      .send(raw);
    expect(res.status).toBe(404);
  });

  test("vote 404 when build does not exist", async () => {
    const raw = jsonBody({ vote: 1 });
    const res = await request(env.app)
      .post("/v1/community-builds/ghost-build/vote")
      .set("X-Client-Id", cid)
      .set("X-Client-Signature", env.sign(raw))
      .set("Content-Type", "application/json")
      .send(raw);
    expect(res.status).toBe(404);
  });

  test("vote rejects bad_id", async () => {
    const raw = jsonBody({ vote: 1 });
    const res = await request(env.app)
      .post("/v1/community-builds/Bad ID!!/vote")
      .set("X-Client-Id", cid)
      .set("X-Client-Signature", env.sign(raw))
      .set("Content-Type", "application/json")
      .send(raw);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_id");
  });

  test("flag rejects bad_id", async () => {
    const raw = jsonBody({});
    const res = await request(env.app)
      .post("/v1/community-builds/Bad ID!!/flag")
      .set("X-Client-Id", cid)
      .set("X-Client-Signature", env.sign(raw))
      .set("Content-Type", "application/json")
      .send(raw);
    expect(res.status).toBe(400);
  });

  test("DELETE rejects bad_id", async () => {
    const res = await request(env.app)
      .delete("/v1/community-builds/Bad ID!!")
      .set("X-Client-Id", cid)
      .set("X-Client-Signature", env.sign(""));
    expect(res.status).toBe(400);
  });

  test("DELETE 404 when build does not exist", async () => {
    const res = await request(env.app)
      .delete("/v1/community-builds/ghost-build")
      .set("X-Client-Id", cid)
      .set("X-Client-Signature", env.sign(""));
    expect(res.status).toBe(404);
  });
});
