"use strict";

const MAX_ANALYSIS_GAME_IDS = 100;

/**
 * Timing samples are a bounded subset of an owned dossier, not a new search
 * surface. An explicit empty list matches no replays; malformed lists fail
 * closed instead of broadening back to the entire opponent history.
 * @param {unknown} raw
 * @returns {string[]|undefined}
 */
function parseAnalysisGameIds(raw) {
  if (raw === undefined) return undefined;
  let value = raw;
  if (typeof raw === "string") {
    if (raw.length > 26_000) throw invalidMembership();
    try { value = JSON.parse(raw); } catch { throw invalidMembership(); }
  }
  if (!Array.isArray(value) || value.length > MAX_ANALYSIS_GAME_IDS) {
    throw invalidMembership();
  }
  if (value.some((id) => typeof id !== "string"
    || id.length === 0 || id.length > 256 || id.trim() !== id
    || /[\u0000-\u001f\u007f]/u.test(id))) {
    throw invalidMembership();
  }
  return [...new Set(value)];
}

function invalidMembership() {
  return Object.assign(new Error("analysisGameIds must be a JSON array of at most 100 game IDs"), {
    status: 400,
    code: "invalid_analysis_game_ids",
  });
}

module.exports = { parseAnalysisGameIds };
