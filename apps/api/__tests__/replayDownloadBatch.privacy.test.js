// @ts-nocheck
"use strict";
const { EventEmitter } = require("events");
const { attachSlowQueryLogging } = require("../src/db/connect");
const { isReplayDownloadBatchPath, isReplayDownloadBatchPost, REPLAY_DOWNLOAD_COMMENT,
  safeReplayDownloadBatchError } = require("../src/middleware/replayDownloadBatchBoundary");
const { privateSearchSentryCallbacks, privateSearchHttpOptions, runPrivateSearchScope,
  PRIVATE_SEARCH_TAG } = require("../src/middleware/privateSearchTelemetry");
const { sanitiseRequestForLog, sanitiseResponseForLog, sanitiseRequestUrl } = require("../src/middleware/requestLogging");
const PATH = "/v1/replays/download-batch", SECRET = "private-owner/private-key?signature=private-signature";

test.each([PATH, PATH + "/", "/V1/Replays/Download-Batch/?ignored=private", "https://api.invalid" + PATH])("exact private matcher accepts Express case/trailing-slash form %s", path => {
  expect(isReplayDownloadBatchPath(path)).toBe(true);
  expect(isReplayDownloadBatchPost({ method: "POST", originalUrl: path })).toBe(true);
  expect(isReplayDownloadBatchPost({ method: "PUT", originalUrl: path })).toBe(false);
});
test.each([PATH + "/child", PATH + "-other", "/v1/replays/other/../download-batch", "/v1/replays/%64ownload-batch", "/v1/games/one/replay-upload"])("neighbor %s retains its ordinary fence/privacy behavior", path => {
  expect(isReplayDownloadBatchPath(path)).toBe(false);
  expect(isReplayDownloadBatchPost({ method: "POST", originalUrl: path })).toBe(false);
});

test("SDK callbacks discard both request copies, transactions, and a safe failure without any request URL", () => {
  const callbacks = privateSearchSentryCallbacks();
  const event = { request: { url: PATH, data: SECRET }, sdkProcessingMetadata: { normalizedRequest: { data: SECRET } } };
  expect(callbacks.beforeSend(event)).toBeNull(); expect(callbacks.beforeSendTransaction(event)).toBeNull();
  const normalized = { request: { data: SECRET }, sdkProcessingMetadata: { normalizedRequest: { url: PATH, data: SECRET } } };
  expect(callbacks.beforeSend(normalized)).toBeNull();
  expect(callbacks.beforeSendTransaction({ transaction: "POST " + PATH, request: { data: SECRET } })).toBeNull();
  const raw = Object.assign(new Error(SECRET), { body: SECRET, cause: new Error(SECRET), type: "entity.parse.failed" });
  const safe = safeReplayDownloadBatchError(raw);
  expect(safe.message).toBe("invalid_replay_download_batch"); expect(safe.body).toBeUndefined(); expect(safe.cause).toBeUndefined();
  expect(callbacks.beforeSend({}, { originalException: safe })).toBeNull();
  expect(callbacks.beforeSendTransaction({}, { originalException: safe })).toBeNull();
});

test("pre-parser HTTP hooks and request-local constant scope suppress batch capture without SDK init or shared state", () => {
  const options = privateSearchHttpOptions();
  expect(options.ignoreIncomingRequestBody(PATH)).toBe(true); expect(options.ignoreIncomingRequests(PATH)).toBe(true);
  expect(options.ignoreIncomingRequestBody("/v1/games/one/replay-upload")).toBe(false);
  const tags = {}, next = jest.fn(), sdk = { withIsolationScope: callback => callback({ setTag: (key, value) => { tags[key] = value; } }), suppressTracing: callback => callback() };
  runPrivateSearchScope({ originalUrl: PATH }, next, sdk);
  expect(next).toHaveBeenCalledTimes(1); expect(tags).toEqual({ [PRIVATE_SEARCH_TAG]: "1" });
  const callbacks = privateSearchSentryCallbacks();
  expect(callbacks.beforeSend({ tags, request: { data: SECRET } })).toBeNull();
  const ordinary = { request: { url: "/v1/maps", data: "ordinary" } };
  expect(callbacks.beforeSend(ordinary)).toBe(ordinary);
});

test.each(["find", "update"])("constant private %s comment prevents raw DB error messages bypassing the HTTP boundary", commandName => {
  const client = new EventEmitter(), logger = { warn: jest.fn() };
  attachSlowQueryLogging(client, logger, 100);
  client.emit("commandStarted", { requestId: 1, commandName, command: { [commandName]: "games", comment: REPLAY_DOWNLOAD_COMMENT } });
  client.emit("commandFailed", { requestId: 1, commandName, duration: 3, failure: new Error(SECRET) });
  expect(logger.warn).toHaveBeenCalledWith({ commandName, collection: "games", durationMs: 3, code: "mongo_command_failed" }, "mongo_command_failed");
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(SECRET);
});

test("HTTP operational serializers exclude selection bodies and ephemeral URL response bodies", () => {
  const request = sanitiseRequestForLog({ method: "POST", url: PATH, body: { gameIds: [SECRET] }, headers: { authorization: SECRET } });
  const response = sanitiseResponseForLog({ headersSent: true, statusCode: 200, body: { url: SECRET }, getHeader: () => undefined });
  expect(JSON.stringify([request, response])).not.toContain(SECRET);
  expect(request.url).toBe(PATH); expect(response).toEqual({ statusCode: 200, headers: {} });
});

test("the private batch log URL drops all arbitrary ignored query fields, preserving unrelated route behavior", () => {
  expect(sanitiseRequestUrl(PATH + "?url=" + encodeURIComponent(SECRET) + "&unused=" + SECRET)).toBe(PATH);
  expect(sanitiseRequestUrl("https://api.invalid/V1/Replays/Download-Batch/?anything=" + SECRET)).toBe(PATH);
  expect(sanitiseRequestUrl("/v1/maps?unused=ordinary")).toBe("/v1/maps?unused=ordinary");
});
