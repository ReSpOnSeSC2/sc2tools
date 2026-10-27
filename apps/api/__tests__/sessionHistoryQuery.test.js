"use strict";

const { queryHistoryRows, MAX_BYTES } = require("../src/services/sessionHistoryQuery");
const { naturalSpan, scopeHash } = require("../src/services/sessionHistoryWindow");
const { historyError } = require("../src/services/sessionHistoryDescriptor");
const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const DATE = new Date("2026-10-25T12:00:00.000Z");
/** @returns {import('../src/services/sessionHistoryTypes').HistoryContext} */
function context() {
  const filters = {}, span = naturalSpan({ windowFrom: "2026-10-25T00:00:00.000Z", windowTo: "2026-10-26T00:00:00.000Z" }, NOW, 90, filters);
  return { mode: "natural", gapMinutes: 90, scopeHash: scopeHash("owner", "natural", 90, filters), filters, span, floor: null, ceiling: NOW, anchor: null };
}
/** @param {Record<string,unknown>[]} rows */
function stream(rows) {
  let index = 0;
  return { next: jest.fn(async () => index < rows.length ? rows[index++] : null), close: jest.fn(async () => {}) };
}
/** Explicit Mongo boundary only; no product normalizer/guard/reader is mocked.
 * @param {import('../src/services/sessionHistoryQuery').HistoryCursor} cursor */
function database(cursor) {
  const aggregate = jest.fn(() => cursor);
  const db = /** @type {Pick<import('../src/db/connect').DbContext,'games'>} */ (/** @type {unknown} */ ({ games: { aggregate } }));
  return { db, aggregate };
}

test("normal stream reads exhaustion, closes and retains one aggregate with small batches", async () => {
  const cursor = stream([{ date: DATE }, { date: DATE }]), { db, aggregate } = database(cursor);
  const result = await queryHistoryRows(db, "owner", context(), () => {});
  expect(result.overflow).toBe(false); expect(result.rows).toHaveLength(2);
  expect(cursor.next).toHaveBeenCalledTimes(3); expect(cursor.close).toHaveBeenCalledTimes(1);
  expect(aggregate).toHaveBeenCalledTimes(1);
  const args = /** @type {unknown[]} */ (aggregate.mock.calls[0]);
  expect(args[1]).toEqual({ maxTimeMS: 2000, allowDiskUse: false, batchSize: 32, collation: { locale: "simple" } });
});

test("row5001 is consumed only as overflow sentinel and the stream closes immediately", async () => {
  const one = await queryHistoryRows(database(stream([{ date: DATE }])).db, "owner", context(), () => {});
  expect(Buffer.byteLength(JSON.stringify(Array.from({ length: 5000 }, () => one.rows[0])))).toBeLessThanOrEqual(MAX_BYTES);
  const cursor = stream(Array.from({ length: 5010 }, () => ({ date: DATE }))), { db } = database(cursor);
  const value = await queryHistoryRows(db, "owner", context(), () => {});
  expect(value).toEqual({ overflow: true, rows: [] });
  expect(cursor.next).toHaveBeenCalledTimes(5001);
  expect(cursor.close).toHaveBeenCalledTimes(1);
});

test("UTF8 byte overflow includes array punctuation and stops before row sentinel", async () => {
  const raw = { date: DATE, map: "😀".repeat(200), myBuild: "x".repeat(200), opponent: { displayName: "y".repeat(200) } };
  const single = stream([raw]);
  const observed = await queryHistoryRows(database(single).db, "owner", context(), () => {});
  // The external contract is the UTF8 size of the normalized JSON ARRAY, not
  // a guessed per-row size or a mock of Buffer/production accounting.
  const rowBytes = Buffer.byteLength(JSON.stringify(observed.rows[0]), "utf8");
  const maxFit = Math.floor((MAX_BYTES - 1) / (rowBytes + 1));
  expect(maxFit).toBeGreaterThan(1); expect(maxFit + 1).toBeLessThan(5001);
  const cursor = stream(Array.from({ length: maxFit + 8 }, () => raw)), { db } = database(cursor);
  const value = await queryHistoryRows(db, "owner", context(), () => {});
  expect(value).toEqual({ overflow: true, rows: [] });
  expect(cursor.next).toHaveBeenCalledTimes(maxFit + 1);
  expect(cursor.close).toHaveBeenCalledTimes(1);
});

test("read failure remains the rejection if cursor cleanup also fails", async () => {
  const read = new Error("read failed"), cleanup = new Error("cleanup failed"), cursor = stream([]);
  cursor.next.mockRejectedValueOnce(read); cursor.close.mockRejectedValueOnce(cleanup);
  await expect(queryHistoryRows(database(cursor).db, "owner", context(), () => {})).rejects.toBe(read);
  expect(cursor.next).toHaveBeenCalledTimes(1); expect(cursor.close).toHaveBeenCalledTimes(1);
});

test("normalization failure closes immediately and is not replaced by cleanup failure", async () => {
  const cursor = stream([{ date: DATE, map: "x".repeat(201) }, { date: DATE }]);
  cursor.close.mockRejectedValueOnce(new Error("cleanup failed"));
  await expect(queryHistoryRows(database(cursor).db, "owner", context(), () => {})).rejects.toMatchObject({ code: "session_history_field_limit", status: 422 });
  expect(cursor.next).toHaveBeenCalledTimes(1); expect(cursor.close).toHaveBeenCalledTimes(1);
});

test("retired policy after a held read closes before any result escapes", async () => {
  const retired = historyError("session_policy_changed", 409), cursor = stream([]);
  let allowed = true;
  cursor.next.mockImplementationOnce(async () => { allowed = false; return { date: DATE }; });
  cursor.close.mockRejectedValueOnce(new Error("cleanup failed"));
  await expect(queryHistoryRows(database(cursor).db, "owner", context(), () => { if (!allowed) throw retired; })).rejects.toBe(retired);
  expect(cursor.next).toHaveBeenCalledTimes(1); expect(cursor.close).toHaveBeenCalledTimes(1);
});

test("cleanup failure after successful exhaustion remains visible", async () => {
  const cleanup = new Error("cleanup failed"), cursor = stream([]);
  cursor.close.mockRejectedValueOnce(cleanup);
  await expect(queryHistoryRows(database(cursor).db, "owner", context(), () => {})).rejects.toBe(cleanup);
  expect(cursor.close).toHaveBeenCalledTimes(1);
});

test("Mongo time limit keeps its availability mapping even if close fails", async () => {
  const cursor = stream([]);
  cursor.next.mockRejectedValueOnce(Object.assign(new Error("maxTimeMS"), { code: 50 }));
  cursor.close.mockRejectedValueOnce(new Error("cleanup failed"));
  await expect(queryHistoryRows(database(cursor).db, "owner", context(), () => {})).rejects.toMatchObject({ code: "session_history_unavailable", status: 503 });
  expect(cursor.close).toHaveBeenCalledTimes(1);
});
