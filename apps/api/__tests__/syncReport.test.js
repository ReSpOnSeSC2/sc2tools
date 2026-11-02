// @ts-nocheck
"use strict";

/**
 * Unit: the heartbeat sync report sanitizer (services/syncReport.js). Only
 * whitelisted fields survive in fixed shapes, nothing can form a `$` or `.`
 * key, and a block above 2 KiB is dropped rather than truncated.
 */

const { sanitizeSyncReport, syncReportFields, SYNC_REPORT_MAX_BYTES, SKIP_REASONS } = require("../src/services/syncReport");

const NOW = Date.parse("2026-11-01T12:00:00Z");
const RLO = String.fromCharCode(0x202e), LONE = String.fromCharCode(0xd800);
const sanitize = (raw) => sanitizeSyncReport(raw, NOW);
const name = (over = {}) => ({ name: "Opponent", toonHandle: "2-S2-1-424242", count: 4, ...over });

/** Every key at every depth of a stored value. */
function keysDeep(value) {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (!value || typeof value !== "object" || value instanceof Date) return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysDeep(inner)]);
}

test("a full contract report survives with its exact shape and types", () => {
  const raw = { pending: 3, archivePending: 1, paused: false, foldersWatched: 2, missingFolders: 0,
    lastUploadAt: "2026-11-01T11:59:30.123456+00:00", lastErrorCode: "upload_timeout",
    skipped: { player_unresolved: 4, ai_game: 2 }, rejected: 1, filtered: 7, unresolvedNames: [name()] };
  expect(sanitize(raw)).toEqual({ report: { pending: 3, archivePending: 1, foldersWatched: 2, missingFolders: 0, rejected: 1,
    filtered: 7, paused: false, lastUploadAt: new Date("2026-11-01T11:59:30.123Z"), lastErrorCode: "upload_timeout",
    skipped: { player_unresolved: 4, ai_game: 2 }, unresolvedNames: [name()] } });
});

test("unknown and injection-shaped keys are dropped at every depth", () => {
  const raw = JSON.parse(JSON.stringify({ pending: 1, $where: "sleep(1)", "a.b": 2, userId: "other", tokenHash: "x", revokedAt: null,
    skipped: { player_unresolved: 3, $gt: 9, "a.b": 9, toString: 9, filtered: 9 },
    unresolvedNames: [{ ...name(), $set: { revokedAt: 1 }, "x.y": 1, isMe: true }] }).replace('"pending":1', '"pending":1,"__proto__":{"paused":true}'));
  const { report } = sanitize(raw);
  expect(report).toEqual({ pending: 1, skipped: { player_unresolved: 3 }, unresolvedNames: [name()] });
  expect(keysDeep(report).filter((key) => key.startsWith("$") || key.includes("."))).toEqual([]);
  expect(Object.getPrototypeOf(report)).toBe(Object.prototype);
});

test.each([
  [-5, 0], [2.9, 2], [0, 0], [5_000_000, 999_999], [Number.MAX_SAFE_INTEGER, 999_999],
])("count %p is clamped to %p", (value, expected) => {
  expect(sanitize({ pending: value }).report).toEqual({ pending: expected });
});

test.each(["3", true, null, [], {}])("non-number count %p is dropped", (value) => {
  expect(sanitize({ pending: value, paused: true }).report).toEqual({ paused: true });
});

test.each([["yes"], [1], [null]])("non-boolean paused %p is dropped", (value) => {
  expect(sanitize({ paused: value, pending: 1 }).report).toEqual({ pending: 1 });
});

test.each([
  ["2026-11-01T11:00:00Z", new Date("2026-11-01T11:00:00Z")],
  ["2026-11-01T11:00Z", new Date("2026-11-01T11:00:00Z")],
  ["2026-11-02T11:00:00Z", new Date("2026-11-02T11:00:00Z")],
  ["2026-11-03T12:00:01Z", undefined],
  ["2009-12-31T23:59:59Z", undefined],
  ["2026-13-40T00:00:00Z", undefined],
  ["Sunday", undefined],
  ["2026-11-01", undefined],
  [1730462400000, undefined],
])("lastUploadAt %p becomes %p", (value, expected) => {
  expect(sanitize({ pending: 0, lastUploadAt: value }).report.lastUploadAt).toEqual(expected);
});

test.each([
  ["network_timeout", true], ["e", true], ["e".repeat(48), true], ["e".repeat(49), false],
  ["Upload_Failed", false], ["upload-failed", false], ["9lives", false], ["$where", false], ["", false], [7, false],
])("lastErrorCode %p accepted: %p", (value, accepted) => {
  expect(sanitize({ pending: 1, lastErrorCode: value }).report.lastErrorCode).toBe(accepted ? value : undefined);
});

test("skipped keeps only the agent's skip codes with positive counts", () => {
  const raw = { skipped: Object.fromEntries([...SKIP_REASONS.map((reason) => [reason, 2]), ["made_up_reason", 4], ["filtered", 1]]) };
  expect(Object.keys(sanitize(raw).report.skipped)).toEqual([...SKIP_REASONS]);
  expect(sanitize({ skipped: { ai_game: 0, player_unresolved: -1 }, pending: 1 }).report).toEqual({ pending: 1 });
  expect(sanitize({ skipped: [3], pending: 1 }).report).toEqual({ pending: 1 });
});

test.each([
  ["seen fewer than three times", name({ count: 2 })],
  ["a malformed toon handle", name({ toonHandle: "2-S2-1" })],
  ["a toon handle with text around it", name({ toonHandle: "x2-S2-1-424242" })],
  ["an over-long toon handle", name({ toonHandle: `2-S2-1-${"9".repeat(30)}` })],
  ["an over-long name", name({ name: "n".repeat(33) })],
  ["an empty name", name({ name: "   " })],
  ["a control character", name({ name: "Bad\nName" })],
  ["a bidi override", name({ name: `Bad${RLO}Name` })],
  ["a lone surrogate", name({ name: `Bad${LONE}` })],
  ["a non-string name", name({ name: 42 })],
  ["a string count", name({ count: "9" })],
])("an unresolved name with %s is dropped", (_label, entry) => {
  expect(sanitize({ pending: 1, unresolvedNames: [entry] }).report).toEqual({ pending: 1 });
});

test("unresolved names are trimmed, deduplicated by toon handle and capped at ten", () => {
  const entries = Array.from({ length: 12 }, (_, i) => name({ name: ` Player${i} `, toonHandle: `1-S2-1-${i % 9}` }));
  const kept = sanitize({ unresolvedNames: entries }).report.unresolvedNames;
  expect(kept.map((entry) => entry.toonHandle)).toEqual(Array.from({ length: 9 }, (_, i) => `1-S2-1-${i}`));
  expect(kept[0]).toEqual({ name: "Player0", toonHandle: "1-S2-1-0", count: 4 });
  expect(sanitize({ unresolvedNames: [name({ name: "界界" })] }).report.unresolvedNames[0].name).toBe("界界");
});

test.each([[null], [[]], ["sync"], [7], [true]])("a non-object block %p is invalid", (raw) => {
  expect(sanitize(raw)).toEqual({ report: null, dropped: "invalid" });
});

test("a block with no recognised field is invalid rather than an empty report", () => {
  expect(sanitize({ $where: 1, status: "ok", skipped: { nope: 1 } })).toEqual({ report: null, dropped: "invalid" });
});

test("a block above 2 KiB is dropped whole, even when its valid part would fit", () => {
  const many = Array.from({ length: 40 }, (_, i) => name({ toonHandle: `1-S2-1-${i}` }));
  expect(Buffer.byteLength(JSON.stringify({ unresolvedNames: many }))).toBeGreaterThan(SYNC_REPORT_MAX_BYTES);
  expect(sanitize({ pending: 1, unresolvedNames: many })).toEqual({ report: null, dropped: "too_large" });
  expect(sanitize({ pending: 1, padding: "x".repeat(SYNC_REPORT_MAX_BYTES) })).toEqual({ report: null, dropped: "too_large" });
  const cyclic = { pending: 1 }; cyclic.self = cyclic;
  expect(sanitize(cyclic)).toEqual({ report: null, dropped: "too_large" });
});

test("a report at every cap (3-byte names, the widest counts) still fits the budget", () => {
  const max = 999_999;
  const big = { pending: max, archivePending: max, foldersWatched: max, missingFolders: max, rejected: max, filtered: max, paused: false,
    lastUploadAt: "2026-11-01T11:00Z", lastErrorCode: "e".repeat(48), skipped: Object.fromEntries(SKIP_REASONS.map((reason) => [reason, max])),
    unresolvedNames: Array.from({ length: 10 }, (_, i) => name({ name: "界".repeat(32), toonHandle: `1-S2-1-${max + i}`, count: max })) };
  expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThanOrEqual(SYNC_REPORT_MAX_BYTES);
  const { report } = sanitize(big);
  expect(report.unresolvedNames).toHaveLength(10);
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(SYNC_REPORT_MAX_BYTES);
});

test("write values keep the stored report without one and guard a report against a newer stored one", () => {
  const now = new Date(NOW), report = { pending: 1, unresolvedNames: [name({ name: "$sync" })] };
  expect(syncReportFields(null, now)).toEqual({ sync: "$sync", syncReportedAt: "$syncReportedAt" });
  const newer = { $and: [{ $eq: [{ $type: "$syncReportedAt" }, "date"] }, { $gt: ["$syncReportedAt", { $literal: now }] }] };
  expect(syncReportFields(report, now)).toEqual({ sync: { $cond: [newer, "$sync", { $literal: report }] },
    syncReportedAt: { $cond: [newer, "$syncReportedAt", { $literal: now }] } });
});
