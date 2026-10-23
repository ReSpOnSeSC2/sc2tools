// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const pino = require("pino");
const { buildAdminRouter } = require("../src/routes/admin");
const { buildErrorHandler } = require("../src/middleware/errorHandler");

function fixture(enabled = true) {
  const analytics = { isEnabled: () => enabled, summary: jest.fn(async () => ({ configured: true })) };
  const app = express();
  app.use("/v1", buildAdminRouter({ auth: (_req, _res, next) => next(), isAdmin: () => true, analytics }));
  app.use(buildErrorHandler(pino({ level: "silent" })));
  return { app, analytics };
}
test("the admin route forwards custom from/to to analytics", async () => {
  const { app, analytics } = fixture();
  const res = await request(app).get("/v1/admin/analytics/summary?from=2026-01-10&to=2026-01-12");
  expect(res.status).toBe(200);
  expect(analytics.summary).toHaveBeenCalledWith(expect.objectContaining({ from: "2026-01-10", to: "2026-01-12" }));
});
test.each([true, false])("invalid custom ranges return 400 even when configured=%s", async (enabled) => {
  const { app, analytics } = fixture(enabled);
  const res = await request(app).get("/v1/admin/analytics/summary?from=2026-02-30&to=2026-03-01");
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("bad_request");
  expect(analytics.summary).not.toHaveBeenCalled();
});
