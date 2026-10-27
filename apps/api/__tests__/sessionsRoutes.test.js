"use strict";

const express = require("express");
const request = require("supertest");
const { buildSessionsRouter } = require("../src/routes/sessions");
const { SessionHistoryService } = require("../src/services/sessionHistory");
const { SessionPolicyService } = require("../src/services/sessionPolicy");
const { OwnerRevisions } = require("../src/util/gameVisibility");
const { encode, digest } = require("../src/services/sessionHistoryDescriptor");
const NOW = Date.parse("2026-10-27T12:00:00.000Z");
/** @returns {{promise:Promise<Record<string,unknown>[]>,resolve:(value:Record<string,unknown>[])=>void}} */
function deferredRows() {
  /** @type {(value:Record<string,unknown>[])=>void} */ let resolve = () => { throw new Error("not initialized"); };
  /** @type {Promise<Record<string,unknown>[]>} */ const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
/** Structural stream boundary used only by this unit double.
 * @param {Record<string,unknown>[]} rows @param {Promise<Record<string,unknown>[]>|null} [held] */
function rowCursor(rows, held = null) {
  let index = 0, current = rows;
  return { next: jest.fn(async () => {
    if (held) { current = await held; held = null; }
    return index < current.length ? current[index++] : null;
  }), close: jest.fn(async () => {}) };
}function setup() {
  const revisions = new OwnerRevisions();
  const profile = async (/** @type {{userId:string}} */ filter) => ({ userId: filter.userId, sessionGapMinutes: 90 });
  const policy = new SessionPolicyService({ users: { findOne: profile }, overlayTokens: { findOne: async () => null } }, { revisions });
  const aggregate = jest.fn(() => rowCursor([]));
  const db = /** @type {Pick<import('../src/db/connect').DbContext,'games'|'users'>} */ (/** @type {unknown} */ ({ games: { aggregate }, users: { findOne: profile } }));
  const service = new SessionHistoryService(db, { sessionPolicy: policy, now: () => NOW });
  /** @type {import('express').RequestHandler} */ const auth = (req, res, next) => {
    const owner = req.get("x-test-owner");
    if (!owner) { res.status(401).json({ error: { code: "unauthorized" } }); return; }
    req.auth = { userId: owner, source: "device" }; next();
  };
  const app = express(); app.use("/v1", buildSessionsRouter({ sessionHistory: service, auth }));
  app.get("/v1/unrelated-public-route", (_req, res) => res.json({ ok: true }));
  /** @type {import('express').ErrorRequestHandler} */ const errors = (error, _req, res, _next) => {
    const value = /** @type {{status?:number,code?:string}} */ (error);
    res.status(value.status ?? 500).json({ error: { code: value.code ?? "internal_error" } });
  };
  app.use(errors);
  return { app, service, revisions, aggregate };
}

test("sessions routes require owner auth and current is registered before descriptor detail", async () => {
  const { app, aggregate } = setup();
  expect((await request(app).get("/v1/sessions")).status).toBe(401);
  expect((await request(app).get("/v1/sessions/current")).status).toBe(401);
  expect((await request(app).get("/v1/sessions/not-a-canonical-descriptor")).status).toBe(401);
  const response = await request(app).get("/v1/sessions/current").set("x-test-owner", "owner");
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.body).toMatchObject({ kind: "current", status: "ready", session: null, activity: "empty" });
  expect(aggregate).toHaveBeenCalledTimes(1);
});

test("Sessions auth leaves unrelated public routes available", async () => {
  const { app, aggregate } = setup();
  const response = await request(app).get("/v1/unrelated-public-route");
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ok: true });
  expect(aggregate).not.toHaveBeenCalled();
});

test("malformed locator is rejected before any games query", async () => {
  const { app, aggregate } = setup();
  const response = await request(app).get("/v1/sessions/not-a-canonical-descriptor").set("x-test-owner", "owner");
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe("session_history_request_invalid");
  expect(aggregate).not.toHaveBeenCalled();
});

test("final sync publication guard rejects held policy/privacy retirement with cache off", async () => {
  const { app, revisions, aggregate } = setup(), held = deferredRows();
  aggregate.mockImplementationOnce(() => rowCursor([], held.promise));
  const response = request(app).get("/v1/sessions").set("x-test-owner", "owner").then(value => value);
  for (let index = 0; index < 30 && aggregate.mock.calls.length === 0; index++) await new Promise(resolve => setImmediate(resolve));
  expect(aggregate).toHaveBeenCalledTimes(1);
  revisions.invalidate("owner"); held.resolve([]);
  const value = await response;
  expect(value.status).toBe(409);
  expect(value.body.error.code).toBe("session_policy_changed");
});

test("foreign-owner descriptor is a consistency failure, never cross-owner query authority", async () => {
  const { app, aggregate } = setup();
  const owner = await request(app).get("/v1/sessions").set("x-test-owner", "owner-a");
  expect(owner.status).toBe(200);
  expect(owner.body.definition.scopeHash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(owner.body)).not.toContain("owner-a");
  const id = encode({ v: 1, k: "natural", s: owner.body.definition.scopeHash, g: 90, a: null,
    f: "2026-10-25T12:00:00.000Z", e: "2026-10-25T12:00:00.000Z", h: digest(["not-authority"]) });
  const foreign = await request(app).get(`/v1/sessions/${id}`).set("x-test-owner", "owner-b");
  expect(foreign.status).toBe(409); expect(foreign.body.error.code).toBe("session_view_changed");
  expect(aggregate).toHaveBeenCalledTimes(1);
});
