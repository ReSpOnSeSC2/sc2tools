// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { buildErrorHandler } = require("../src/middleware/errorHandler");

function appWith(error) {
  const logged = [];
  const logger = { error: (fields, message) => logged.push({ fields, message }) };
  const app = express();
  app.get("/v1/*", () => { throw error; });
  app.use(buildErrorHandler(logger));
  return { app, logged };
}

describe("error logs for requests that carry typed search text", () => {
  test("log the error's kind only, never its message", async () => {
    const error = Object.assign(new Error("regex /Rival/i failed"), { status: 503, code: "replay_search_unavailable", codeName: "BadValue" });
    const { app, logged } = appWith(error);
    const res = await request(app).get("/v1/replays?search=Rival&window=recent").expect(503);
    expect(res.body.error.code).toBe("replay_search_unavailable");
    expect(logged).toHaveLength(1);
    expect(logged[0].fields.err).toEqual({ type: "Error", code: "replay_search_unavailable", codeName: "BadValue" });
    expect(JSON.stringify(logged)).not.toContain("Rival");
  });

  test("keep the whole error elsewhere", async () => {
    const error = Object.assign(new Error("boom"), { status: 500 });
    const { app, logged } = appWith(error);
    await request(app).get("/v1/replays?limit=5").expect(500);
    expect(logged[0].fields.err).toBe(error);
  });
});
