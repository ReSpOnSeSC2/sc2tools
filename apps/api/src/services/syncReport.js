"use strict";

/**
 * Heartbeat sync report (roadmap item 76; contract in
 * docs/handoff/sync-health-api-checkpoint.md). A current desktop agent may add
 *
 *   sync: { pending, archivePending, paused, foldersWatched, missingFolders,
 *           lastUploadAt, lastErrorCode, skipped: { <reason>: n }, rejected,
 *           filtered, unresolvedNames: [{ name, toonHandle, count }] }
 *
 * to POST /v1/devices/heartbeat. Only the whitelisted fields survive, rebuilt
 * into fresh objects whose keys are fixed here, so no stored key can begin
 * with `$` or contain `.`. A block that is not an object or has no recognised
 * field is dropped, and so is one that re-serializes above
 * SYNC_REPORT_MAX_BYTES, as sent or once sanitized; the heartbeat itself
 * still succeeds. Unresolved names are other players' names and toon
 * handles: they stay on the owner's own device row.
 */

const SYNC_REPORT_MAX_BYTES = 2048;
const COUNT_MAX = 999_999; // six digits, so a report at every cap still fits the byte budget
const COUNT_FIELDS = Object.freeze(["pending", "archivePending", "foldersWatched", "missingFolders", "rejected", "filtered"]);
/** The agent's skip codes (apps/agent/sc2tools_agent/replay_pipeline.py). */
const SKIP_REASONS = Object.freeze(["ai_game", "resumed_replay", "player_unresolved", "no_result",
  "parse_failed", "analysis_failed", "file_unstable", "playback_budget_exceeded", "unsupported_replay"]);
const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,47}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const TOON_HANDLE_RE = /^\d+-S2-\d+-\d+$/;
// Control and bidi characters, and lone UTF-16 surrogates (malformed text).
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const NAME_MAX = 32;
const TOON_HANDLE_MAX = 32;
const UNRESOLVED_MAX = 10;
const UNRESOLVED_MIN_COUNT = 3;
// No replay predates StarCraft II; a time far ahead of the server clock is corrupt, not skewed.
const EARLIEST_UPLOAD_MS = Date.UTC(2010, 0, 1);
const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** Own properties only, so nothing inherited is ever read. @param {Record<string, unknown>} raw @param {string} key */
const own = (raw, key) => (Object.hasOwn(raw, key) ? raw[key] : undefined);

/** A non-negative integer clamped to COUNT_MAX, or null. @param {unknown} value */
function count(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(COUNT_MAX, Math.max(0, Math.trunc(value))) : null;
}

/** An ISO-8601 time between 2010 and a day past the server clock, or null. @param {unknown} value @param {number} now */
function uploadTime(value, now) {
  if (typeof value !== "string" || value.length > 40 || !ISO_RE.test(value)) return null;
  const at = Date.parse(value);
  return at >= EARLIEST_UPLOAD_MS && at <= now + FUTURE_SKEW_MS ? new Date(at) : null;
}

/** Positive counts for the known skip reasons only. @param {unknown} value */
function skippedCounts(value) {
  if (!isRecord(value)) return null;
  /** @type {Record<string, number>} */
  const out = {};
  for (const reason of SKIP_REASONS) {
    const n = count(own(value, reason));
    if (n) out[reason] = n;
  }
  return Object.keys(out).length ? out : null;
}

/** @param {unknown} entry */
function unresolvedName(entry) {
  if (!isRecord(entry)) return null;
  const rawName = own(entry, "name"), toonHandle = own(entry, "toonHandle"), seen = count(own(entry, "count"));
  if (typeof rawName !== "string" || typeof toonHandle !== "string" || seen === null) return null;
  const name = rawName.trim();
  const valid = name.length > 0 && name.length <= NAME_MAX && !UNSAFE_TEXT_RE.test(name)
    && toonHandle.length <= TOON_HANDLE_MAX && TOON_HANDLE_RE.test(toonHandle) && seen >= UNRESOLVED_MIN_COUNT;
  return valid ? { name, toonHandle, count: seen } : null;
}

/** At most UNRESOLVED_MAX valid entries, one per toon handle. @param {unknown} value */
function unresolvedNames(value) {
  if (!Array.isArray(value)) return null;
  /** @type {Set<string>} */
  const handles = new Set();
  /** @type {Array<{ name: string, toonHandle: string, count: number }>} */
  const out = [];
  for (const entry of value.slice(0, UNRESOLVED_MAX)) {
    const item = unresolvedName(entry);
    if (item && !handles.has(item.toonHandle)) { handles.add(item.toonHandle); out.push(item); }
  }
  return out.length ? out : null;
}

/** Each field appears only when valid. @param {Record<string, unknown>} raw @param {number} now */
function buildReport(raw, now) {
  /** @type {Record<string, unknown>} */
  const report = {};
  for (const field of COUNT_FIELDS) {
    const n = count(own(raw, field));
    if (n !== null) report[field] = n;
  }
  const paused = own(raw, "paused"), lastErrorCode = own(raw, "lastErrorCode");
  if (typeof paused === "boolean") report.paused = paused;
  const lastUploadAt = uploadTime(own(raw, "lastUploadAt"), now);
  if (lastUploadAt) report.lastUploadAt = lastUploadAt;
  if (typeof lastErrorCode === "string" && ERROR_CODE_RE.test(lastErrorCode)) report.lastErrorCode = lastErrorCode;
  const skipped = skippedCounts(own(raw, "skipped")), names = unresolvedNames(own(raw, "unresolvedNames"));
  if (skipped) report.skipped = skipped;
  if (names) report.unresolvedNames = names;
  return /** @type {import('./types').SyncReport} */ (report);
}

/** Compact UTF-8 JSON within the budget; a value JSON cannot hold never fits. @param {unknown} value */
function fitsBudget(value) {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= SYNC_REPORT_MAX_BYTES; } catch { return false; }
}

/**
 * Example: sanitizeSyncReport({ pending: 2, paused: true, $where: 1 }, Date.now())
 *   → { report: { pending: 2, paused: true } }
 * @param {unknown} raw the heartbeat body's `sync` value
 * @param {number} now server clock in ms, the bound for lastUploadAt
 * @returns {{ report: import('./types').SyncReport | null, dropped?: "invalid" | "too_large" }}
 */
function sanitizeSyncReport(raw, now) {
  if (!isRecord(raw)) return { report: null, dropped: "invalid" };
  if (!fitsBudget(raw)) return { report: null, dropped: "too_large" };
  const report = buildReport(raw, now);
  if (!Object.keys(report).length) return { report: null, dropped: "invalid" };
  // Today's caps keep a fitting block fitting; this bounds the stored size if the whitelist grows.
  return fitsBudget(report) ? { report } : { report: null, dropped: "too_large" };
}

/**
 * `$set` values for the heartbeat pipeline. Without an accepted report the
 * stored report and its time stay as they are. An accepted report replaces
 * them unless the stored one is newer, so a delayed request never rolls a
 * newer report back. The report time is the server's receive time.
 * @param {import('./types').SyncReport | null} report @param {Date} now
 */
function syncReportFields(report, now) {
  if (!report) return { sync: "$sync", syncReportedAt: "$syncReportedAt" };
  const newer = { $and: [{ $eq: [{ $type: "$syncReportedAt" }, "date"] }, { $gt: ["$syncReportedAt", { $literal: now }] }] };
  return { sync: { $cond: [newer, "$sync", { $literal: report }] },
    syncReportedAt: { $cond: [newer, "$syncReportedAt", { $literal: now }] } };
}

module.exports = { sanitizeSyncReport, syncReportFields, SYNC_REPORT_MAX_BYTES, SKIP_REASONS };
