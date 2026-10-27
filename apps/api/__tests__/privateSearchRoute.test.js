"use strict";

jest.mock("../src/util/sentry", () => ({ captureException: jest.fn() }));
const { EventEmitter } = require("events");
const express = require("express"), request = require("supertest");
const { buildErrorHandler } = require("../src/middleware/errorHandler");
const { buildPrivateSearchRouter, parseQuery, createPrivateSearchLifetime,
  DEADLINE_MS } = require("../src/routes/privateSearchRoute");
const { buildPrivateSearchJsonParser, privateSearchErrorBoundary,
  privateSearchNoStore } = require("../src/middleware/privateSearchBoundary");
const PATH = "/v1/search/quick", SECRET = "PRIVATE_ROUTE_SENTINEL";
const RESPONSE = JSON.stringify({ version: 2, groups: {
  opponents: { status: "ready", items: [], hasMore: false },
  customBuilds: { status: "ready", items: [], hasMore: false },
  maps: { status: "unavailable", reason: "deferred", items: [], hasMore: null },
} });

/** @param {import('express').RequestHandler} [authenticate] */
function fixture(authenticate) {
  const app = express(), error = jest.fn();
  const quick = jest.fn(/** @param {string} _owner @param {string} _q
   * @param {import('../src/services/privateSearchIdentity').ReadScope} _scope */
    async (_owner, _q, _scope) => RESPONSE);
  /** @type {import('express').RequestHandler} */
  const auth = authenticate || ((req, _res, next) => {
    req.auth = { userId: "owner", source: "clerk", clerkUserId: "user_owner" }; next();
  });
  const privateSearch = /** @type {import('../src/services/privateSearchService').PrivateSearchService} */
    (/** @type {unknown} */ ({ quick }));
  app.use(privateSearchNoStore); app.use(buildPrivateSearchJsonParser());
  app.use("/v1", buildPrivateSearchRouter({ privateSearch, auth }));
  app.use(privateSearchErrorBoundary);
  app.use(buildErrorHandler(/** @type {import('pino').Logger} */ (/** @type {unknown} */ ({ error }))));
  return { app, quick, error };
}

test.each([PATH, PATH + "/", "/V1/SEARCH/QUICK"])("actual POST %s uses owner and literal body", async path => {
  const f = fixture(), response = await request(f.app).post(path).send({ q: "  St  " }).expect(200);
  expect(response.text).toBe(RESPONSE); expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(f.quick).toHaveBeenCalledWith("owner", "St", expect.objectContaining({
    signal: expect.any(AbortSignal), check: expect.any(Function), clerkUserId: "user_owner",
  }));
  expect(f.error).not.toHaveBeenCalled();
});

test("conditional headers never produce an ETag or a private304 response", async () => {
  const f = fixture();
  const response = await request(f.app).post(PATH).set("If-None-Match", "*").send({ q: "St" }).expect(200);
  expect(response.text).toBe(RESPONSE);
  expect(response.headers.etag).toBeUndefined();
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(Number(response.headers["content-length"])).toBe(Buffer.byteLength(RESPONSE));
});

test("device auth delegates current identity checking to the same service without a supplied Clerk ID", async () => {
  const f = fixture((req, _res, next) => { req.auth = { userId: "owner", source: "device" }; next(); });
  await request(f.app).post(PATH).send({ q: "St" }).expect(200);
  expect(f.quick.mock.calls[0][2].clerkUserId).toBeUndefined();
});

test.each([{ q: "a" }, { q: "ab\n" }, { q: "a\u0085b" }, { q: "a\ud800b" },
  { q: "ab", owner: "foreign" }, { q: ["ab"] }, { q: "a".repeat(81) }, null])(
  "invalid or unknown request fields cannot execute search %#", async body => {
    const f = fixture();
    const response = await request(f.app).post(PATH).set("content-type", "application/json")
      .send(JSON.stringify(body)).expect(400);
    expect(response.body.error.code).toBe("private_search_invalid_request"); expect(f.quick).not.toHaveBeenCalled();
    expect(response.headers["cache-control"]).toBe("private, no-store");
  },
);

test("missing/incomplete authenticated identity and a rejected method do no service work", async () => {
  const f = fixture((_req, _res, next) => next());
  await request(f.app).post(PATH).send({ q: "St" }).expect(401);
  const response = await request(f.app).get(PATH + "?unknown=" + SECRET).expect(405);
  expect(response.headers.allow).toBe("POST");
  expect(response.body.error.code).toBe("private_search_method_not_allowed");
  expect(f.quick).not.toHaveBeenCalled(); expect(JSON.stringify(f.error.mock.calls)).not.toContain(SECRET);
});

test("an unexpected raw service error reaches the shared handler only as a fresh fixed error", async () => {
  const f = fixture();
  f.quick.mockRejectedValue(Object.assign(new Error(SECRET), { code: SECRET, body: SECRET, cause: new Error(SECRET) }));
  const response = await request(f.app).post(PATH).send({ q: "St" }).expect(500);
  expect(response.body.error.code).toBe("private_search_failed");
  expect(JSON.stringify(f.error.mock.calls)).not.toContain(SECRET); expect(response.text).not.toContain(SECRET);
});

test("the actual parser rejects a raw body over1024bytes before auth/service work", async () => {
  const f = fixture();
  await request(f.app).post(PATH).send({ q: SECRET.repeat(100) }).expect(413);
  expect(f.quick).not.toHaveBeenCalled(); expect(JSON.stringify(f.error.mock.calls)).not.toContain(SECRET);
});

test("unsupported media is415 and never reaches private search", async () => {
  const f = fixture();
  const response = await request(f.app).post(PATH).type("text").send(SECRET).expect(415);
  expect(response.body.error.code).toBe("private_search_unsupported_media_type");
  expect(f.quick).not.toHaveBeenCalled();
  expect(response.headers["cache-control"]).toBe("private, no-store");
});

test("literal query validation accepts80astral points without public aliases", () => {
  expect(parseQuery({ q: "  " + "😀".repeat(80) + "  " })).toBe("😀".repeat(80));
  expect(parseQuery({ q: "É  [a].*" })).toBe("É  [a].*");
});

test("HTTP lifetime rejects on its deadline but does not pretend held service work settled", async () => {
  jest.useFakeTimers();
  const req = new EventEmitter(), res = Object.assign(new EventEmitter(), { writableEnded: false });
  const clock = createPrivateSearchLifetime(/** @type {import('express').Request} */ (/** @type {unknown} */ (req)),
    /** @type {import('express').Response} */ (/** @type {unknown} */ (res)));
  /** @type {(value:string)=>void} */ let release = () => {};
  /** @type {Promise<string>} */ const work = new Promise(resolve => { release = resolve; });
  let actualSettled = false; void work.then(() => { actualSettled = true; });
  const waiting = clock.wait(work);
  const assertion = expect(waiting).rejects.toMatchObject({ code: "private_search_deadline" });
  try {
    jest.advanceTimersByTime(DEADLINE_MS); await assertion;
    expect(clock.signal.aborted).toBe(true); expect(actualSettled).toBe(false);
    release("complete"); await work; expect(actualSettled).toBe(true);
  } finally {
    clock.close(); expect(req.listenerCount("aborted")).toBe(0); expect(res.listenerCount("close")).toBe(0);
    expect(jest.getTimerCount()).toBe(0); jest.useRealTimers();
  }
});
