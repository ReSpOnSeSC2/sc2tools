"use strict";

/** Actual stored source only; malformed/missing logs remain unknown.
 * @param {unknown} log @returns {{v: number, available: boolean}|null}
 */
function opponentBuildOrderStamp(log) {
  if (!Array.isArray(log) || log.length > 5000
    || log.some((line) => typeof line !== "string" || line.length > 256)) return null;
  if (!log.length) return { v: 1, available: false };
  const available = log.some((line) => {
    const match = /^\[(\d{1,4}):([0-5]\d)\]\s+([A-Za-z][A-Za-z0-9]*)\s*$/.exec(line);
    return match && Number(match[1]) * 60 + Number(match[2]) <= 86400
      && !/^(Beacon|Reward|Spray)/.test(match[3]);
  });
  return available ? { v: 1, available: true } : null;
}

/** Kept beside Trends facts so its existing history backfill cannot erase it.
 * @param {Record<string, any>} fields @returns {Record<string, any>}
 */
function opponentBuildOrderSummaryUpdate(fields) {
  return Object.prototype.hasOwnProperty.call(fields, "oppBuildLog")
    ? { opponentListDetail: { v: 1, opponentBuildOrder: opponentBuildOrderStamp(fields.oppBuildLog) } }
    : {};
}

module.exports = { opponentBuildOrderStamp, opponentBuildOrderSummaryUpdate };
