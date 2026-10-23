"use strict";

/** Only aggregate numbers and bounded labels may cross the public boundary. */
function publicArchiveOverview(/** @type {any} */ page) {
  /** @type {Record<string, any>} */
  const out = {};
  if (page.summary && typeof page.summary === "object") {
    const count = (/** @type {unknown} */ value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)) : 0;
    const avg = page.summary.avgDurationSec;
    out.summary = { total: count(page.summary.total), wins: count(page.summary.wins), losses: count(page.summary.losses), ties: count(page.summary.ties), avgDurationSec: typeof avg === "number" && Number.isFinite(avg) && avg >= 0 && avg <= 86_400 ? avg : null };
    out.total = out.summary.total;
  }
  if (page.facets && typeof page.facets === "object") {
    out.facets = {
      matchups: Array.isArray(page.facets.matchups) ? [...new Set(page.facets.matchups.filter((/** @type {unknown} */ value) => typeof value === "string" && /^[PTZR]v[PTZR]$/.test(value)))].slice(0, 16) : [],
      maps: Array.isArray(page.facets.maps) ? [...new Set(page.facets.maps.filter((/** @type {unknown} */ value) => typeof value === "string" && value.trim()).map((/** @type {string} */ value) => value.trim().slice(0, 64)))].slice(0, 30) : [],
    };
  }
  return out;
}

module.exports = { publicArchiveOverview };
