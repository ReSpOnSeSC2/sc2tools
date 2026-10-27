// @ts-nocheck
"use strict";

const { EventEmitter } = require("events");
const { withUserDataWriteFence } = require("../src/middleware/userDataWriteFence");

async function exercise(method, originalUrl, authError) {
  const users = { updateOne: jest.fn(async () => ({ matchedCount: 1 })) };
  const req = { method, originalUrl, body: { readOnly: true }, log: { warn: jest.fn() } };
  const res = new EventEmitter();
  const auth = jest.fn((request, _response, next) => {
    if (!authError) request.auth = { userId: "owner", source: "device" };
    next(authError);
  });
  const next = jest.fn();
  const fence = withUserDataWriteFence(auth, users);
  fence(req, res, next);
  await new Promise(resolve => setImmediate(resolve));
  // Normal completion releases and clears the existing write-lease timer.
  res.emit("finish");
  await new Promise(resolve => setImmediate(resolve));
  return { req, users, auth, next };
}

test.each(["/v1/search/quick", "/v1/search/quick/", "/V1/SEARCH/QUICK?unknown=private"])(
  "only the exact read-only POST %s authenticates without a mutation lease", async path => {
    const f = await exercise("POST", path);
    expect(f.auth).toHaveBeenCalledTimes(1);
    expect(f.req.auth).toEqual({ userId: "owner", source: "device" });
    expect(f.next).toHaveBeenCalledWith();
    expect(f.users.updateOne).not.toHaveBeenCalled();
  },
);

test.each([
  ["POST", "/v1/search/quick/child"], ["POST", "/v1/other/../search/quick"],
  ["PUT", "/v1/search/quick"], ["PATCH", "/v1/search/quick"],
  ["DELETE", "/v1/search/quick"], ["POST", "/v1/games"],
])("%s %s still acquires the ordinary write lease despite body.readOnly", async (method, path) => {
  const f = await exercise(method, path);
  expect(f.auth).toHaveBeenCalledTimes(1);
  expect(f.users.updateOne).toHaveBeenCalledTimes(2);
  expect(f.users.updateOne.mock.calls[0][0]).toMatchObject({ userId: "owner", _gdprMutation: { $exists: false } });
  expect(f.next).toHaveBeenCalledWith();
});

test("a rejected credential is never exempted from authentication", async () => {
  const failure = Object.assign(new Error("invalid_token"), { code: "invalid_token", status: 401 });
  const f = await exercise("POST", "/v1/search/quick", failure);
  expect(f.req.auth).toBeUndefined();
  expect(f.next).toHaveBeenCalledWith(failure);
  expect(f.users.updateOne).not.toHaveBeenCalled();
});
