// @ts-nocheck
"use strict";
const { parseDownloadBatch, captureMarker, packProjection, safeDownloadFields, boundedRow,
  MAX_ROW_BYTES, MAX_GAMES } = require("../src/services/replayDownloadBatchPolicy");

test.each([null, [], {}, { gameIds: [] }, { gameIds: ["one"], owner: "foreign" }, { gameIds: ["one"], url: "https://private.test" },
  { gameIds: "one" }, { gameIds: [1] }, { gameIds: [null] }, { gameIds: [{}] }, { gameIds: [["one"]] },
  { gameIds: [" "] }, { gameIds: ["x".repeat(201)] }, { gameIds: ["x\ny"] }, { gameIds: ["\ud800"] },
  { gameIds: ["\udc00"] }, { gameIds: ["https://private.test/a"] }, { gameIds: ["s3:bucket/key"] }, { gameIds: ["//private.test/a"] },
  { gameIds: ["one", " one "] }, { gameIds: Array.from({ length: 101 }, () => "one") },
])("rejects the entire raw selection without normalization/coercion: %j", body => {
  expect(() => parseDownloadBatch(body)).toThrow(expect.objectContaining({ status: 400, code: "invalid_replay_download_batch" }));
});

test("raw100 IDs are validated before dedupe and copied into an immutable bounded selection", () => {
  const input = Array.from({ length: MAX_GAMES }, (_, i) => ` game-${i} `);
  const ids = parseDownloadBatch({ gameIds: input });
  input[0] = "changed";
  expect(ids[0]).toBe("game-0"); expect(ids).toHaveLength(100); expect(Object.isFrozen(ids)).toBe(true);
  expect(parseDownloadBatch({ gameIds: ["valid-\ud83c\udfae"] })).toEqual(["valid-\ud83c\udfae"]);
});

test("101 unique raw IDs are rejected before replay IO", () => {
  const gameIds = Array.from({ length: 101 }, (_, index) => `unique-${index}`);
  expect(() => parseDownloadBatch({ gameIds })).toThrow(expect.objectContaining({ status: 400, code: "invalid_replay_download_batch" }));
});

test("marker capture keeps exact optional absence and expression BSON types rather than array-matching query types", () => {
  const game = { replayFile: { sizeBytes: 8, sha256: "a".repeat(64), storedAt: "2026-11-02T00:00:00Z" },
    __packType_sizeBytes: "double", __packType_sha256: "string", __packType_storedAt: "string",
    __packType_version: "missing", __packType_uploadId: "missing", __packType_md5: "missing" };
  const captured = captureMarker(game);
  expect(captured.predicate.$and).toContainEqual({ "replayFile.uploadId": { $exists: false } });
  expect(captured.predicate.$and).toContainEqual({ $expr: { $eq: [{ $type: "$replayFile.sizeBytes" }, "double"] } });
  expect(captured.values.storedAt).toBe(game.replayFile.storedAt);
  expect(captureMarker({ ...game, replayFile: { ...game.replayFile, uploadId: null }, __packType_uploadId: "null" })).toBeNull();
  expect(packProjection()).toHaveProperty("__packType_uploadId", { $type: "$replayFile.uploadId" });
  expect(packProjection()).not.toHaveProperty("replayFile");
});

test.each([
  ["https://private.test/" + "x".repeat(4096), "a.SC2Replay"], ["javascript:private", "a.SC2Replay"],
  ["https://name:password@private.test/a", "a.SC2Replay"], ["https://private.test/a#private", "a.SC2Replay"],
  ["https://private.test/a", "x".repeat(256)], ["https://private.test/a", "bad/path.SC2Replay"],
])("fixed response-field guards reject unsafe values", (url, filename) => {
  expect(safeDownloadFields(url, filename)).toBe(false);
});

test("encoded row budget counts UTF8 bytes rather than character count", () => {
  expect(boundedRow({ value: "x".repeat(MAX_ROW_BYTES) })).toBe(false);
  expect(boundedRow({ value: "\ud83c\udfae".repeat(2100) })).toBe(false);
  expect(boundedRow({ gameId: "one", status: "unavailable", code: "replay_unavailable" })).toBe(true);
});
