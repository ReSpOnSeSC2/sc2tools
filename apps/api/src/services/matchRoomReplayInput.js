"use strict";

const { sha256 } = require("../util/hash");
const { MatchRoomError } = require("./matchRoomError");

/** @typedef {import("./matchRoomModel").Seat} Seat */
/** @typedef {{mapKey: string, winnerSeat: Seat, durationSec: number, endedAt: number,
 * receipt: string, toonDigests: Record<Seat, string>}} ReplayInput */

const FIELDS = ["type", "mapKey", "winnerSeat", "durationSec", "endedAt", "receipt", "toonDigests"];
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_DURATION_SECONDS = 24 * 60 * 60;

/** Keep in step with the web currentMapPoolKey. The API deploys from its own directory. @param {string} name */
function replayMapKey(name) {
  const tokens = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/['\u2019]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (tokens.length >= 3 && tokens.slice(-2).join(" ") === "ladder edition") tokens.splice(-2);
  else if (tokens.length >= 2 && ["le", "te", "ce", "re"].includes(tokens.at(-1) ?? "")) tokens.pop();
  return tokens.join("");
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function isDigest(value) {
  return typeof value === "string" && DIGEST.test(value);
}

/** @param {unknown} value @returns {Record<Seat, string>} */
function replayDigests(value) {
  if (!isRecord(value) || Object.keys(value).length !== 2 || !isDigest(value.a) || !isDigest(value.b) || value.a === value.b) {
    throw new MatchRoomError(400, "invalid_match_replay");
  }
  return { a: value.a, b: value.b };
}

/** @param {string} mapKey @param {number} endedAt @param {number} durationSec @param {Record<Seat, string>} toonDigests */
function replayReceipt(mapKey, endedAt, durationSec, toonDigests) {
  return sha256(JSON.stringify(["match-room/replay/v1", mapKey, endedAt, durationSec, ...Object.values(toonDigests).sort()]));
}

/** @param {Record<string, unknown>} action @returns {ReplayInput} */
function readReplayInput(action) {
  if (Object.keys(action).some(key => !FIELDS.includes(key)) || !validReplayFields(action)) {
    throw new MatchRoomError(400, "invalid_match_replay");
  }
  const { mapKey, winnerSeat, durationSec, endedAt, receipt } = action;
  const toonDigests = replayDigests(action.toonDigests);
  if (receipt !== replayReceipt(mapKey, endedAt, durationSec, toonDigests)) {
    throw new MatchRoomError(400, "invalid_match_replay");
  }
  return { mapKey, winnerSeat, durationSec, endedAt, receipt, toonDigests };
}

/** @param {unknown} value @returns {value is number} */
function positiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** @param {Record<string, unknown>} action @returns {action is Record<string, unknown> & Omit<ReplayInput, "toonDigests">} */
function validReplayFields(action) {
  const { mapKey, winnerSeat, durationSec, endedAt, receipt } = action;
  return typeof mapKey === "string" && /^[a-z0-9]{1,128}$/u.test(mapKey)
    && (winnerSeat === "a" || winnerSeat === "b")
    && positiveInteger(durationSec) && durationSec <= MAX_DURATION_SECONDS
    && positiveInteger(endedAt) && isDigest(receipt);
}

module.exports = { readReplayInput, replayMapKey, replayReceipt };
