// @ts-nocheck
"use strict";

/**
 * /v1/health — deep health check.
 *
 * Render uses this path for BOTH liveness and the autoscaling probe,
 * so it must (a) verify the write path, not just the read ping — a
 * read-only/degraded cluster previously returned 200 while every
 * ingest failed — and (b) report degradation as a 503 with a
 * per-check breakdown rather than a 500 through the error handler.
 */

const express = require("express");
const request = require("supertest");
const { buildHealthRouter } = require("../src/routes/health");

function buildApp({ pingFails = false, writeFails = false } = {}) {
  const updateOne = jest.fn(async () => {
    if (writeFails) throw new Error("not writable");
    return { acknowledged: true };
  });
  const db = {
    client: {
      db: () => ({
        admin: () => ({
          ping: async () => {
            if (pingFails) throw new Error("no server");
            return { ok: 1 };
          },
        }),
      }),
    },
    db: {
      collection: (name) => {
        expect(name).toBe("jobLocks");
        return { updateOne };
      },
    },
  };
  const app = express();
  app.use(buildHealthRouter({ db }));
  return { app, updateOne };
}

describe("GET /health", () => {
  test("200 ok when ping and write both succeed", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.checks).toEqual({ mongoPing: true, mongoWrite: true });
  });

  test("503 degraded (not 500) when the write path fails", async () => {
    const { app } = buildApp({ writeFails: true });
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.checks).toEqual({ mongoPing: true, mongoWrite: false });
  });

  test("503 degraded when the ping fails, write probe skipped", async () => {
    const { app, updateOne } = buildApp({ pingFails: true });
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ mongoPing: false, mongoWrite: false });
    expect(updateOne).not.toHaveBeenCalled();
  });

  test("write probe result is cached across rapid probes", async () => {
    const { app, updateOne } = buildApp();
    await request(app).get("/health");
    await request(app).get("/health");
    await request(app).get("/health");
    // Render polls aggressively; the upsert must not multiply.
    expect(updateOne).toHaveBeenCalledTimes(1);
  });
});

describe("GET /ping", () => {
  test("instant 200 with no DB interaction", async () => {
    const { app, updateOne } = buildApp({ pingFails: true, writeFails: true });
    const res = await request(app).get("/ping");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(updateOne).not.toHaveBeenCalled();
  });
});
