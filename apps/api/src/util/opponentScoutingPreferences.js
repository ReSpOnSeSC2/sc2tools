"use strict";

const OPPONENT_SCOUTING_PREF_TYPE = "opponentScouting";
/** @param {unknown} raw @param {boolean} [strict] */
function sanitizeOpponentScouting(raw, strict = false) {
  const valid = raw && typeof raw === "object" && !Array.isArray(raw);
  const record = /** @type {Record<string,unknown>} */ (valid ? raw : {});
  if (strict && (!valid || Object.keys(record).some(key => key !== "groupByPlayer") || typeof record.groupByPlayer !== "boolean")) {
    throw Object.assign(new Error("Choose whether to group the same player."), { status: 400, code: "invalid_opponent_scouting" });
  }
  return { groupByPlayer: record.groupByPlayer !== false };
}
module.exports = { OPPONENT_SCOUTING_PREF_TYPE, sanitizeOpponentScouting };
