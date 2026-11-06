// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const pino = require("pino");
const { buildGuidesRouter, GUIDE_REVISION_CACHE_CONTROL } = require("../src/routes/guides");
const { buildErrorHandler } = require("../src/middleware/errorHandler");

function harness(overrides = {}) {
  const guides = { matchup: jest.fn() };
  const auth = jest.fn((_req, res) => res.status(401).end());
  const readRevision = jest.fn().mockResolvedValue("b6702af3-0cd7-4ce4-a829-09e82279d234");
  const app = express();
  app.use("/v1", buildGuidesRouter({
    guides, auth, enabled: true, guideSamples: {}, guideFreshness: { readRevision }, ...overrides,
  }));
  app.use(buildErrorHandler(pino({ level: "silent" })));
  return { app, guides, auth, readRevision };
}

describe("public guide revision route", () => {
  test("is public, precedes matchup routing and returns only the opaque version", async () => {
    const { app, guides, auth, readRevision } = harness();
    const res = await request(app).get("/v1/guides/revision");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revision: await readRevision.mock.results[0].value });
    expect(res.headers["cache-control"]).toBe(GUIDE_REVISION_CACHE_CONTROL);
    expect(res.headers["cache-control"]).toBe("public, max-age=0, s-maxage=15, must-revalidate");
    expect(auth).not.toHaveBeenCalled();
    expect(guides.matchup).not.toHaveBeenCalled();
  });

  test("the Guides feature flag also disables revision checks without caching the 404", async () => {
    const { app, readRevision } = harness({ enabled: false });
    const res = await request(app).get("/v1/guides/revision");
    expect(res.status).toBe(404);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(readRevision).not.toHaveBeenCalled();
  });

  test("missing optional freshness service is unavailable instead of a fake version", async () => {
    const { app } = harness({ guideFreshness: undefined });
    const res = await request(app).get("/v1/guides/revision");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { code: "guide_revision_unavailable" } });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("database failures remain uncacheable and expose no internal data", async () => {
    const { app, readRevision } = harness();
    readRevision.mockRejectedValue(new Error("private database detail"));
    const res = await request(app).get("/v1/guides/revision");
    expect(res.status).toBe(500);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(res.body)).not.toContain("private database detail");
  });

  test("background checks are still rate limited and limit errors are uncacheable", async () => {
    const { app, readRevision } = harness({ limitPerMinute: 1 });
    expect((await request(app).get("/v1/guides/revision")).status).toBe(200);
    const res = await request(app).get("/v1/guides/revision");
    expect(res.status).toBe(429);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(readRevision).toHaveBeenCalledTimes(1);
  });
});
