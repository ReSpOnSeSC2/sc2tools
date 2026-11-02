"use strict";

/**
 * Ingest rejection counters (roadmap item 76). POST /v1/games answers each
 * refused game with free-text `errors`; rejectionCode maps them to a closed
 * code set, so a counter key never comes from request text. The owner row
 * keeps one bounded window:
 *
 *   ingestStats: { rejected: { <code>: n }, rejectedSince: Date, lastRejectedAt: Date }
 *
 * The first batch after the window ends starts a new one, so old rejections
 * age out and the Sync health warning can clear. Retryable rejections are
 * transient server failures the agent retries, and `game_deleted` is the
 * owner's own deletion: neither is a sync problem, so neither is counted.
 * Only the desktop agent's uploads are counted (routes/gamesIngestPolicy.js).
 */

const REJECTION_CODES = Object.freeze(["validation_failed", "game_deleted", "quarantine_failed",
  "upsert_failed", "custom_build_tag_retry_required", "quarantine_repair_failed"]);
const UNCOUNTED_CODES = new Set(["game_deleted"]);
const REJECTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Every rejection that is not one of the named server-side failures is a
 * validation failure today (AJV text, a non-object body, play signatures).
 * Example: rejectionCode({ errors: ["upsert_failed: timeout"] }) === "upsert_failed"
 * @param {{ errors?: unknown }} entry
 */
function rejectionCode(entry) {
  const first = Array.isArray(entry.errors) && typeof entry.errors[0] === "string" ? entry.errors[0] : "";
  const prefix = first.split(":", 1)[0];
  return REJECTION_CODES.includes(prefix) ? prefix : "validation_failed";
}

/**
 * Counted codes for one batch's `rejected[]`.
 * Example: rejectionCounts([{ errors: ["/ must be object"] }, { retryable: true, errors: ["upsert_failed: x"] }])
 *   → { validation_failed: 1 }
 * @param {Array<{ retryable?: unknown, errors?: unknown }>} rejected
 */
function rejectionCounts(rejected) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const entry of rejected) {
    if (!entry || entry.retryable === true) continue;
    const code = rejectionCode(entry);
    if (!UNCOUNTED_CODES.has(code)) counts[code] = (counts[code] || 0) + 1;
  }
  return counts;
}

/**
 * One pipeline update for the owner row, or null when nothing counts. Codes
 * outside the closed set are ignored, so every written path is fixed here.
 * @param {Record<string, number>} counts @param {Date} now
 */
function ingestRejectionUpdate(counts, now) {
  const entries = Object.entries(counts).filter(([code, n]) => REJECTION_CODES.includes(code) && !UNCOUNTED_CODES.has(code)
    && Number.isInteger(n) && n > 0);
  if (!entries.length) return null;
  const current = { $gt: ["$ingestStats.rejectedSince", { $literal: new Date(now.getTime() - REJECTION_WINDOW_MS) }] };
  const added = Object.fromEntries(entries.map(([code, n]) => [code, { $add: [{ $ifNull: [`$ingestStats.rejected.${code}`, 0] }, n] }]));
  return [{ $set: {
    "ingestStats.rejected": { $cond: [current, { $mergeObjects: ["$ingestStats.rejected", added] }, { $literal: Object.fromEntries(entries) }] },
    "ingestStats.rejectedSince": { $cond: [current, "$ingestStats.rejectedSince", { $literal: now }] },
    "ingestStats.lastRejectedAt": { $max: ["$ingestStats.lastRejectedAt", { $literal: now }] },
  } }];
}

/**
 * The stored stats, rebuilt from the closed code set; null when absent.
 * @param {any} doc users row
 * @returns {{ rejected: Record<string, number>, rejectedSince: Date|null, lastRejectedAt: Date|null } | null}
 */
function ingestStatsDto(doc) {
  const stats = doc && doc.ingestStats;
  if (!stats || typeof stats !== "object") return null;
  /** @type {Record<string, number>} */
  const rejected = {};
  for (const code of REJECTION_CODES) {
    const n = stats.rejected && typeof stats.rejected === "object" ? stats.rejected[code] : undefined;
    if (Number.isInteger(n) && n > 0 && !UNCOUNTED_CODES.has(code)) rejected[code] = n;
  }
  const date = (/** @type {unknown} */ value) => (value instanceof Date ? value : null);
  return { rejected, rejectedSince: date(stats.rejectedSince), lastRejectedAt: date(stats.lastRejectedAt) };
}

/**
 * Rejections from the current window, or null once the last one is older
 * than REJECTION_WINDOW_MS.
 * @param {ReturnType<typeof ingestStatsDto> | undefined} stats @param {number} now
 */
function recentRejections(stats, now) {
  const last = stats && stats.lastRejectedAt ? stats.lastRejectedAt.getTime() : NaN;
  if (!stats || !(now - last <= REJECTION_WINDOW_MS)) return null;
  const count = Object.values(stats.rejected).reduce((sum, n) => sum + n, 0);
  return count > 0 ? { count, byCode: { ...stats.rejected }, since: stats.rejectedSince, lastRejectedAt: stats.lastRejectedAt } : null;
}

module.exports = {
  REJECTION_CODES, REJECTION_WINDOW_MS,
  rejectionCode, rejectionCounts, ingestRejectionUpdate, ingestStatsDto, recentRejections,
};
