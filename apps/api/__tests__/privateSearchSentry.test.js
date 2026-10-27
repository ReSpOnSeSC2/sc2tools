// @ts-nocheck
"use strict";

const mockScope = { setTag: jest.fn() };
const mockSdk = {
  init: jest.fn(), captureException: jest.fn(), flush: jest.fn(async () => {}),
  httpIntegration: jest.fn(options => ({ name: "Http", options })),
  withIsolationScope: jest.fn(callback => callback(mockScope)),
  suppressTracing: jest.fn(callback => callback()),
};
jest.mock("@sentry/node", () => mockSdk);
const { PRIVATE_SEARCH_TAG } = require("../src/middleware/privateSearchTelemetry");

function load() {
  let result;
  jest.isolateModules(() => {
    result = {
      ...require("../src/util/sentry"),
      ...require("../src/middleware/privateSearchBoundary"),
    };
  });
  return result;
}
const previousDsn = process.env.SENTRY_DSN;
afterEach(() => {
  if (previousDsn === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = previousDsn;
});

test("disabled SDK remains a no-op and still continues private requests", () => {
  delete process.env.SENTRY_DSN;
  const sentry = load(), next = jest.fn();
  expect(sentry.init()).toBe(false);
  sentry.privateSearchRequestScope({ originalUrl: "/v1/search/quick" }, {}, next);
  sentry.captureException(new Error("ordinary"));
  expect(next).toHaveBeenCalledTimes(1);
  expect(mockSdk.init).not.toHaveBeenCalled();
  expect(mockSdk.captureException).not.toHaveBeenCalled();
});

test("actual optional init replaces only HTTP defaults and installs both whole-event drops", () => {
  process.env.SENTRY_DSN = "https://example.invalid/fixture";
  const sentry = load();
  expect(sentry.init()).toBe(true);
  const options = mockSdk.init.mock.calls[0][0];
  const ordinary = { name: "ExistingOther" }, oldHttp = { name: "Http" };
  const integrations = options.integrations([ordinary, oldHttp]);
  expect(integrations).toEqual([ordinary, expect.objectContaining({ name: "Http" })]);
  const http = mockSdk.httpIntegration.mock.calls[0][0];
  for (const path of ["/v1/search/quick?unknown=private", "/V1/SEARCH/QUICK/"]) {
    expect(http.ignoreIncomingRequests(path)).toBe(true);
    expect(http.ignoreIncomingRequestBody(path)).toBe(true);
    expect(options.beforeSend({ request: { url: path } })).toBeNull();
    expect(options.beforeSendTransaction({ request: { url: path } })).toBeNull();
  }
  expect(http.ignoreIncomingRequests("/v1/search/quick/other")).toBe(false);
  expect(http.ignoreIncomingRequestBody("/v1/games")).toBe(false);
  const event = { request: { url: "/v1/games" } };
  expect(options.beforeSend(event)).toBe(event);
  expect(options.beforeSendTransaction(event)).toBe(event);
});

test("private request tags and suppresses its real next chain without changing ordinary chains", () => {
  process.env.SENTRY_DSN = "https://example.invalid/fixture";
  const sentry = load(), next = jest.fn();
  sentry.privateSearchRequestScope({ originalUrl: "/v1/search/quick?ignored=secret" }, {}, next);
  expect(mockSdk.withIsolationScope).toHaveBeenCalledTimes(1);
  expect(mockScope.setTag).toHaveBeenCalledWith(PRIVATE_SEARCH_TAG, "1");
  expect(mockSdk.suppressTracing).toHaveBeenCalledWith(next);
  expect(next).toHaveBeenCalledTimes(1);
  sentry.privateSearchRequestScope({ originalUrl: "/v1/games" }, {}, next);
  expect(next).toHaveBeenCalledTimes(2);
  expect(mockSdk.withIsolationScope).toHaveBeenCalledTimes(1);
});

test("manual capture skips sanitized private errors and retains unrelated diagnostics", () => {
  process.env.SENTRY_DSN = "https://example.invalid/fixture";
  const sentry = load();
  sentry.captureException(sentry.safePrivateSearchError(new Error("private sentinel")));
  expect(mockSdk.captureException).not.toHaveBeenCalled();
  const ordinary = new Error("ordinary");
  sentry.captureException(ordinary);
  expect(mockSdk.captureException).toHaveBeenCalledWith(ordinary);
});
