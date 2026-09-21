"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { countCloud } = require("../reconcile");

test("countCloud uses a complete library count beyond the first page", async (t) => {
  const requests = [];
  t.mock.method(global, "fetch", async (url) => {
    requests.push(String(url));
    return { ok: true, json: async () => ({ items: Array(100).fill({}), total: 1001, nextCursor: "later" }) };
  });
  assert.deepEqual(await countCloud("https://api.test/v1/custom-builds", {}, () => {}), { total: 1001 });
  assert.equal(requests.length, 1);
});

test("countCloud follows opaque modern cursors when no total is supplied", async (t) => {
  const requests = [];
  t.mock.method(global, "fetch", async (url) => {
    requests.push(new URL(url));
    return {
      ok: true,
      json: async () => requests.length === 1
        ? { items: Array(100).fill({}), nextCursor: "opaque+/cursor" }
        : { items: [{ slug: "build-101" }], nextCursor: null },
    };
  });
  assert.deepEqual(await countCloud("https://api.test/v1/custom-builds", {}, () => {}), { total: 101 });
  assert.equal(requests[1].searchParams.get("cursor"), "opaque+/cursor");
  assert.equal(requests[1].searchParams.has("before"), false);
});

test("countCloud preserves legacy nextBefore pagination", async (t) => {
  const requests = [];
  t.mock.method(global, "fetch", async (url) => {
    requests.push(new URL(url));
    return {
      ok: true,
      json: async () => requests.length === 1
        ? { items: [{}, {}], nextBefore: "2026-01-01T00:00:00Z" }
        : { items: [{}], nextBefore: null },
    };
  });
  assert.deepEqual(await countCloud("https://api.test/v1/games", {}, () => {}), { total: 3 });
  assert.equal(requests[1].searchParams.get("before"), "2026-01-01T00:00:00Z");
  assert.equal(requests[1].searchParams.has("cursor"), false);
});

test("countCloud reports a stalled pagination cursor instead of a partial count", async (t) => {
  t.mock.method(global, "fetch", async () => ({
    ok: true, json: async () => ({ items: [{}], nextCursor: "same" }),
  }));
  assert.deepEqual(await countCloud("https://api.test/v1/custom-builds", {}, () => {}), { total: null, error: "repeated_cursor" });
});
