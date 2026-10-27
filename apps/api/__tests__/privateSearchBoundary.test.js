"use strict";

jest.mock("../src/util/sentry", () => ({ captureException: jest.fn() }));
const express = require("express");
const request = require("supertest");
const sentry = require("../src/util/sentry");
const { buildErrorHandler } = require("../src/middleware/errorHandler");
const {
  BODY_LIMIT, isPrivateSearchPath, isPrivateSearchPost, privateSearchLogUrl,
  privateSearchNoStore, safePrivateSearchError, isPrivateSearchFailure,
  buildPrivateSearchJsonParser, privateSearchErrorBoundary,
} = require("../src/middleware/privateSearchBoundary");
const {
  PRIVATE_SEARCH_TAG, privateSearchSentryCallbacks, privateSearchHttpOptions,
} = require("../src/middleware/privateSearchTelemetry");

const SECRET = "PRIVATE_SEARCH_QUERY_SENTINEL_314";
const PRIVATE = "/v1/search/quick";

/** @param {string} message @param {number} status @param {string} [code] */
function failure(message, status, code) {
  return Object.assign(new Error(message), {
    status, ...(code ? { code } : {}), body: SECRET, cause: new Error(SECRET),
  });
}

function fixture() {
  const app = express(), error = jest.fn();
  /** @type {string[]} */
  const urls = [];
  app.use(privateSearchNoStore);
  app.use((req, _res, next) => { urls.push(privateSearchLogUrl(req.originalUrl)); next(); });
  app.use(buildPrivateSearchJsonParser());
  app.use(express.json());
  app.post(PRIVATE, (req, res, next) => {
    if (req.get("x-test-failure") === "auth") { next(failure(SECRET, 500, "auth_failed")); return; }
    if (req.get("x-test-failure") === "unexpected") { next(failure(SECRET, 500, SECRET)); return; }
    if (req.get("x-test-failure") === "quota") {
      next(Object.assign(failure(SECRET, 429, "private_search_rate_limited"), { retryAfter: 12 }));
      return;
    }
    res.json({ ok: true });
  });
  app.get(PRIVATE, (_req, _res, next) => { next(failure(SECRET, 500)); });
  app.post("/ordinary", (_req, _res, next) => { next(failure(SECRET, 503)); });
  app.use(privateSearchErrorBoundary);
  const logger = /** @type {import("pino").Logger} */ (/** @type {unknown} */ ({ error }));
  app.use(buildErrorHandler(logger));
  return { app, error, urls };
}

/** @param {ReturnType<typeof fixture>} value */
function logged(value) {
  return JSON.stringify(value.error.mock.calls);
}

beforeEach(() => jest.clearAllMocks());

test.each(["constructor", "toString", "__proto__"])("prototype key %s is not an allowlisted error code", key => {
  const value = safePrivateSearchError({ code: key, type: key });
  expect(value).toMatchObject({ status: 500, code: "private_search_failed", message: "private_search_failed" });
});

// Exact private search boundary.
test.each([
  PRIVATE, PRIVATE + "/", "/V1/SEARCH/QUICK", PRIVATE + "?unknown=" + SECRET,
  "https://api.example.invalid" + PRIVATE + "?q=" + SECRET,
])("recognizes only its accepted route shape: %s", (path) => {
  expect(isPrivateSearchPath(path)).toBe(true);
  expect(isPrivateSearchPost({ method: "POST", originalUrl: path })).toBe(true);
  expect(isPrivateSearchPost({ method: "PATCH", originalUrl: path })).toBe(false);
  expect(privateSearchLogUrl(path)).toBe(PRIVATE);
});

test.each([
  "/v1/search", PRIVATE + "/extra", PRIVATE + "-extra", "/v1/other/../search/quick",
  PRIVATE + "\n", "/v1/maps?q=" + PRIVATE, null, {},
])("does not broaden the read-only predicate: %p", (path) => {
  expect(isPrivateSearchPath(path)).toBe(false);
  expect(isPrivateSearchPost({ method: "POST", originalUrl: path })).toBe(false);
});

test("does not authenticate, set req.auth or exempt another write", () => {
  const req = { method: "POST", originalUrl: PRIVATE };
  expect(isPrivateSearchPost(req)).toBe(true);
  expect(req).toEqual({ method: "POST", originalUrl: PRIVATE });
  expect(isPrivateSearchPost({ method: "POST", originalUrl: "/v1/games" })).toBe(false);
  expect(privateSearchLogUrl("/v1/maps?q=" + SECRET)).toBe("/v1/maps?q=" + SECRET);
});

test("maps fresh safe errors without raw body, message or cause", () => {
  const original = failure(SECRET, 500, SECRET);
  const safe = safePrivateSearchError(original);
  expect(safe).not.toBe(original);
  expect(safe.message).toBe("private_search_failed");
  expect(safe.code).toBe("private_search_failed");
  expect(safe.status).toBe(500);
  expect(Object.keys(safe).sort()).toEqual(["code", "status"]);
  expect("body" in safe).toBe(false);
  expect("cause" in safe).toBe(false);
  expect(isPrivateSearchFailure(safe)).toBe(true);
  expect(isPrivateSearchFailure(original)).toBe(false);
  expect(JSON.stringify(safe)).not.toContain(SECRET);
});

test("cleanup uncertainty retains its fixed retryable status without private details", () => {
  const safe = safePrivateSearchError({ code: "private_search_cleanup_failed", message: SECRET });
  expect(safe).toMatchObject({ code: "private_search_cleanup_failed", status: 503 });
  expect(JSON.stringify(safe)).not.toContain(SECRET);
});

test.each([0, 61, 1.5, SECRET])("does not copy unsafe Retry-After: %p", (retryAfter) => {
  const safe = safePrivateSearchError({ code: "private_search_rate_limited", retryAfter });
  expect(safe.retryAfter).toBeUndefined();
});

test.each([
  { code: "private_search_invalid_owner", status: 401 },
  { code: "private_search_busy", status: 503 },
  { code: "private_search_rate_limited", status: 429 },
])("preserves fixed capacity code $code without the original error", ({ code, status }) => {
  const original = failure(SECRET, 500, code), safe = safePrivateSearchError(original);
  expect(safe).not.toBe(original);
  expect(safe.code).toBe(code);
  expect(safe.status).toBe(status);
  expect(safe.message).toBe(code);
  expect(safe).not.toHaveProperty("cause");
  expect(JSON.stringify(safe)).not.toContain(SECRET);
});
// Actual Express parser through shared error handler.
test("valid JSON is accepted with no-store and a fixed logged URL", async () => {
  const value = fixture();
  const response = await request(value.app).post(PRIVATE + "?unknown=" + SECRET).send({ q: SECRET });
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(value.urls).toEqual([PRIVATE]);
  expect(value.error).not.toHaveBeenCalled();
  expect(sentry.captureException).not.toHaveBeenCalled();
});

test("malformed JSON cannot expose body-parser's raw body", async () => {
  const value = fixture();
  const response = await request(value.app).post(PRIVATE + "?q=" + SECRET)
    .set("content-type", "application/json").send('{"q":"' + SECRET);
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe("private_search_invalid_request");
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(logged(value)).not.toContain(SECRET);
  expect(JSON.stringify(response.body)).not.toContain(SECRET);
  expect(value.error.mock.calls[0][0].err).not.toHaveProperty("body");
  expect(sentry.captureException).not.toHaveBeenCalled();
});

test("the 1024-byte parser rejects an oversized body without retaining it", async () => {
  const value = fixture();
  const response = await request(value.app).post(PRIVATE).send({ q: SECRET + "x".repeat(BODY_LIMIT) });
  expect(response.status).toBe(413);
  expect(response.body.error.code).toBe("private_search_body_too_large");
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(logged(value)).not.toContain(SECRET);
});

test("escaped maximum-length Unicode input still fits the small JSON parser", async () => {
  const value = fixture(), body = '{"q":"' + "\\ud83d\\ude00".repeat(80) + '"}';
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(BODY_LIMIT);
  const response = await request(value.app).post(PRIVATE)
    .set("content-type", "application/json").send(body);
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
});

test.each([
  { mode: "auth", status: 401, code: "auth_failed" },
  { mode: "unexpected", status: 500, code: "private_search_failed" },
])("fresh $mode errors reach shared logging without private text", async ({ mode, status, code }) => {
  const value = fixture();
  const response = await request(value.app).post(PRIVATE + "?other=" + SECRET)
    .set("x-test-failure", mode).send({ q: SECRET });
  expect(response.status).toBe(status);
  expect(response.body.error.code).toBe(code);
  expect(logged(value)).not.toContain(SECRET);
  expect(JSON.stringify(response.body)).not.toContain(SECRET);
  const safe = value.error.mock.calls[0][0].err;
  expect(isPrivateSearchFailure(safe)).toBe(true);
  if (status === 500) {
    expect(sentry.captureException).toHaveBeenCalledWith(safe);
    // Existing SDK wiring is pending; the new pure drop callback handles this hint.
    expect(privateSearchSentryCallbacks().beforeSend({}, { originalException: safe })).toBeNull();
  }
});

test("quota keeps only a bounded fixed Retry-After", async () => {
  const value = fixture();
  const response = await request(value.app).post(PRIVATE).set("x-test-failure", "quota").send({ q: "ab" });
  expect(response.status).toBe(429);
  expect(response.headers["retry-after"]).toBe("12");
  expect(logged(value)).not.toContain(SECRET);
});

test("rejected GET strips unknown URL keys and maps its failure", async () => {
  const value = fixture();
  const response = await request(value.app).get(PRIVATE + "?unknown=" + SECRET);
  expect(response.status).toBe(500);
  expect(value.urls).toEqual([PRIVATE]);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(logged(value)).not.toContain(SECRET);
});

test("unrelated route errors and query logging retain existing behavior", async () => {
  const value = fixture();
  const response = await request(value.app).post("/ordinary?q=" + SECRET).send({});
  expect(response.status).toBe(503);
  expect(response.headers["cache-control"]).toBeUndefined();
  expect(value.urls).toEqual(["/ordinary?q=" + SECRET]);
  const original = value.error.mock.calls[0][0].err;
  expect(original.message).toBe(SECRET);
  expect(isPrivateSearchFailure(original)).toBe(false);
  expect(sentry.captureException).toHaveBeenCalledWith(original);
});
// Optional SDK callbacks without SDK activation.
test.each([
  { request: { url: "https://api.example.invalid" + PRIVATE + "?q=" + SECRET } },
  { transaction: "POST " + PRIVATE },
  { tags: { [PRIVATE_SEARCH_TAG]: "1" } },
  { sdkProcessingMetadata: { normalizedRequest: { url: PRIVATE } } },
])("drops a whole known-private exception and transaction: %p", (event) => {
  const callbacks = privateSearchSentryCallbacks();
  expect(callbacks.beforeSend(event)).toBeNull();
  expect(callbacks.beforeSendTransaction(event)).toBeNull();
});

test("constant scope/error identity works when request URL is absent", () => {
  const callbacks = privateSearchSentryCallbacks(), safe = safePrivateSearchError(new Error(SECRET));
  expect(callbacks.beforeSend({}, { originalException: safe })).toBeNull();
  expect(callbacks.beforeSendTransaction({ tags: { [PRIVATE_SEARCH_TAG]: true } })).toBeNull();
  const ordinary = { request: { url: "/v1/maps?q=" + SECRET } };
  expect(callbacks.beforeSend(ordinary)).toBe(ordinary);
  expect(callbacks.beforeSendTransaction(ordinary)).toBe(ordinary);
});

test("HTTP hooks prevent only this route's early body/span capture", () => {
  const options = privateSearchHttpOptions();
  expect(options.ignoreIncomingRequestBody(PRIVATE + "?q=" + SECRET)).toBe(true);
  expect(options.ignoreIncomingRequests(PRIVATE)).toBe(true);
  expect(options.ignoreIncomingRequestBody("/v1/games")).toBe(false);
  expect(options.ignoreIncomingRequests("/v1/maps")).toBe(false);
});
