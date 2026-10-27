// @ts-nocheck
"use strict";

const { EventEmitter } = require("events");
const { BSON } = require("mongodb");
const { readPrivateFacet, decodeRawFacet } = require("../src/services/privateSearchReader");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(values) {
  const cursor = new EventEmitter();
  cursor.next = jest.fn(async () => values.shift() ?? null);
  cursor.close = jest.fn(async () => { cursor.emit("close"); });
  const collection = { aggregate: jest.fn(() => cursor) };
  const signal = new AbortController();
  const check = () => { if (signal.signal.aborted) throw Object.assign(new Error("retired"), { code: "private_search_retired" }); };
  return { cursor, collection, signal, check };
}
const shape = { pipeline: [{ $facet: { source: [], rows: [] } }], options: { hint: "owned-index" } };
const raw = () => BSON.serialize({ source: [], rows: [] });

test("measures the original BSON document before normalization and exhausts its cursor", async () => {
  const bytes = raw(), f = fixture([bytes]);
  await expect(readPrivateFacet(f.collection, shape, f.signal.signal, f.check)).resolves.toEqual({
    envelopes: [{ source: [], rows: [] }], rawBsonBytes: bytes.length,
  });
  expect(f.cursor.next).toHaveBeenCalledTimes(2);
  expect(f.cursor.close).toHaveBeenCalledTimes(1);
  expect(f.collection.aggregate).toHaveBeenCalledWith(shape.pipeline, expect.objectContaining({
    raw: true, maxTimeMS: 300, timeoutMS: 300, timeoutMode: "cursorLifetime",
    allowDiskUse: false, batchSize: 1, hint: "owned-index", readPreference: "primary",
    comment: "sc2tools-private-search-v2",
  }));
});

test.each([null, {}, Buffer.alloc(65_537), Buffer.from([5, 0, 0, 0, 1])])("invalid raw input cannot become a smaller success", value => {
  expect(() => decodeRawFacet(value)).toThrow("private_search_invalid_data");
});

test("a BSON subarray is measured independently of its surrounding allocation", () => {
  const bytes = raw(), allocation = new Uint8Array(bytes.length + 100);
  allocation.set(bytes, 50);
  expect(decodeRawFacet(allocation.subarray(50, 50 + bytes.length))).toEqual({
    envelope: { source: [], rows: [] }, rawBsonBytes: bytes.length,
  });
});

test("a second document retires the packet rather than truncating it", async () => {
  const f = fixture([raw(), raw()]);
  await expect(readPrivateFacet(f.collection, shape, f.signal.signal, f.check)).rejects.toMatchObject({
    code: "private_search_invalid_data",
  });
  expect(f.cursor.close).toHaveBeenCalledTimes(1);
});

test("abort waits for actual read and close settlement, then rejects buffered data", async () => {
  const f = fixture([]), read = deferred(), close = deferred();
  f.cursor.next.mockImplementationOnce(() => read.promise);
  f.cursor.close.mockImplementation(() => close.promise.then(() => { f.cursor.emit("close"); }));
  let settled = false;
  const worker = readPrivateFacet(f.collection, shape, f.signal.signal, f.check);
  void worker.then(() => { settled = true; }, () => { settled = true; });
  f.signal.abort();
  await Promise.resolve(); expect(settled).toBe(false);
  read.resolve(raw());
  await Promise.resolve(); expect(settled).toBe(false);
  close.resolve();
  await expect(worker).rejects.toMatchObject({ code: "private_search_retired" });
  expect(f.cursor.close).toHaveBeenCalledTimes(1);
});

test("private database messages never escape the fixed error mapping", async () => {
  const f = fixture([]);
  f.cursor.next.mockRejectedValueOnce(new Error("private-query-sentinel"));
  await expect(readPrivateFacet(f.collection, shape, f.signal.signal, f.check)).rejects.toMatchObject({
    message: "private_search_unavailable", code: "private_search_unavailable",
  });
});

test.each([[27, "private_search_missing_access_path"], [50, "private_search_deadline"]])(
  "maps database code %s without exposing the original query or retrying",
  async (code, expected) => {
    const f = fixture([]);
    f.cursor.next.mockRejectedValueOnce(Object.assign(new Error("private-query-sentinel"), { code }));
    await expect(readPrivateFacet(f.collection, shape, f.signal.signal, f.check)).rejects.toMatchObject({
      message: expected, code: expected,
    });
    expect(f.collection.aggregate).toHaveBeenCalledTimes(1);
    expect(f.cursor.close).toHaveBeenCalledTimes(1);
  },
);

test("unfulfilled cleanup is explicit and must not be treated as a reusable permit", async () => {
  const f = fixture([raw()]);
  f.cursor.close.mockRejectedValue(new Error("connection not closed"));
  await expect(readPrivateFacet(f.collection, shape, f.signal.signal, f.check)).rejects.toMatchObject({
    code: "private_search_cleanup_failed",
  });
});

test("a real driver operation deadline uses a fixed error and still closes the cursor", async () => {
  const f = fixture([]);
  f.cursor.next.mockRejectedValueOnce(new (require("mongodb").MongoOperationTimeoutError)("private timeout detail"));
  await expect(readPrivateFacet(f.collection, shape, f.signal.signal, f.check)).rejects.toMatchObject({
    code: "private_search_deadline", message: "private_search_deadline",
  });
  expect(f.cursor.close).toHaveBeenCalledTimes(1);
});

test.each([
  ["private query: hint provided does not correspond to an existing index", "private_search_missing_access_path"],
  ["private query: another BadValue", "private_search_unavailable"],
])("only the observed native missing-hint error is classified: %s", async (message, expected) => {
  const f = fixture([]);
  f.cursor.next.mockRejectedValueOnce(new (require("mongodb").MongoServerError)({ code: 2, codeName: "BadValue", errmsg: message }));
  await expect(readPrivateFacet(f.collection, shape, f.signal.signal, f.check)).rejects.toMatchObject({
    message: expected, code: expected,
  });
  expect(f.collection.aggregate).toHaveBeenCalledTimes(1);
  expect(f.cursor.close).toHaveBeenCalledTimes(1);
});
