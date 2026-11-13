"use strict";

const { MatchRoomError } = require("./matchRoomError");
const { readReplayInput, replayMapKey } = require("./matchRoomReplayInput");

/** @typedef {import("./matchRoomModel").Seat} Seat */
/** @typedef {import("./matchRoomModel").Role} Role */
/** @typedef {import("./matchRoomModel").RoomState} RoomState */
/** @typedef {import("./matchRoomReplayInput").ReplayInput} ReplayInput */
/** @typedef {{source: "manual", recordedAt: number}} ManualScore */
/** @typedef {{source: "replay", receipt: string, endedAt: number, submittedBy: Seat, confirmed: boolean}} ReplayScore */
/** @typedef {ManualScore|ReplayScore} ScoreDetail */
/** @typedef {{vetoCompletedAt?: number, replaySeats?: Record<Seat, string>,
 * scoreDetails?: (ScoreDetail|null)[], replayCutoffs?: Record<number, number>, undoBy?: Seat|null}} ScoreHistory */

const FUTURE_GRACE_MS = 60_000;

/** @param {RoomState} state @param {Seat} seat @param {Record<string, unknown>} action
 * @param {number} now @param {(state: RoomState, winner: Seat) => RoomState} record @returns {RoomState} */
function reportReplay(state, seat, action, now, record) {
  const report = readReplayInput(action);
  if (!canReportReplay(state)) throw new MatchRoomError(409, "replay_scoring_unavailable");
  const details = scoreDetails(state);
  assertReplaySeats(state, report);
  const existing = details.findIndex(detail => detail?.source === "replay" && detail.receipt === report.receipt);
  if (existing >= 0) return confirmReplay(state, details, existing, seat, report.winnerSeat);
  assertNewReplay(state, details, report, now);
  const updated = record(state, report.winnerSeat);
  return { ...updated, replaySeats: report.toonDigests, undoBy: null, scoreDetails: [...details,
    { source: "replay", receipt: report.receipt, endedAt: report.endedAt, submittedBy: seat, confirmed: false }] };
}

/** @param {RoomState} state @param {ReplayInput} report */
function assertReplaySeats(state, report) {
  const bound = state.replaySeats;
  if (bound && (bound.a !== report.toonDigests.a || bound.b !== report.toonDigests.b)) {
    throw new MatchRoomError(409, "replay_seats_changed");
  }
}

/** @param {RoomState} state @param {(ScoreDetail|null)[]} details @param {number} index @param {Seat} seat @param {Seat} winner */
function confirmReplay(state, details, index, seat, winner) {
  const detail = details[index];
  if (detail?.source !== "replay" || state.winners[index] !== winner) throw new MatchRoomError(409, "replay_result_conflict");
  // Same-seat retries and third submissions leave the recorded evidence unchanged.
  if (detail.submittedBy === seat || detail.confirmed) return state;
  const scoreDetails = details.slice();
  scoreDetails[index] = { ...detail, confirmed: true };
  return { ...state, scoreDetails };
}

/** @param {RoomState} state @param {(ScoreDetail|null)[]} details @param {ReplayInput} report @param {number} now */
function assertNewReplay(state, details, report, now) {
  if (state.phase !== "play") throw new MatchRoomError(409, "score_changed");
  const map = state.order[state.winners.length];
  const name = state.config.maps[map];
  if (name === undefined || report.mapKey !== replayMapKey(name)) {
    throw new MatchRoomError(409, "replay_map_mismatch");
  }
  const cutoff = Math.max(state.vetoCompletedAt ?? 0, state.replayCutoffs?.[map] ?? 0, latestGameTime(details));
  if (report.endedAt <= cutoff || report.endedAt > now + FUTURE_GRACE_MS) {
    throw new MatchRoomError(409, "replay_time_mismatch");
  }
}

/** @param {(ScoreDetail|null)[]} details */
function latestGameTime(details) {
  return details.reduce((latest, game) => Math.max(latest, scoreTime(game)), 0);
}

/** @param {ScoreDetail|null} detail */
function scoreTime(detail) {
  if (!detail) return 0;
  return detail.source === "replay" ? detail.endedAt : detail.recordedAt;
}

/** @param {RoomState} state */
function scoreDetails(state) {
  // Old rooms have winners but no metadata. Their scores stay manual.
  return state.winners.map((_, index) => state.scoreDetails?.[index] ?? null);
}

/** @param {RoomState} state @param {RoomState} updated @param {number} now @returns {RoomState} */
function addManualScore(state, updated, now) {
  return { ...updated, undoBy: null, scoreDetails: [...scoreDetails(state), { source: "manual", recordedAt: now }] };
}

/** @param {RoomState} state @param {Role} role @returns {RoomState} */
function undoScore(state, role) {
  if (!state.winners.length) throw new MatchRoomError(400, "invalid_room_action");
  if (role === "host") return removeLastScore(state);
  if (role === "watch") throw new MatchRoomError(403, "seat_required");
  if (state.undoBy === role) return state;
  return state.undoBy ? removeLastScore(state) : { ...state, undoBy: role };
}

/** @param {RoomState} state @returns {RoomState} */
function removeLastScore(state) {
  const details = scoreDetails(state);
  const last = details.at(-1);
  const map = state.order[state.winners.length - 1];
  const remaining = details.slice(0, -1);
  // A bounded per-map cutoff keeps a removed replay from adding the win back.
  const replayCutoffs = last?.source === "replay"
    ? { ...state.replayCutoffs, [map]: Math.max(state.replayCutoffs?.[map] ?? 0, last.endedAt) }
    : state.replayCutoffs;
  const next = { ...state, phase: /** @type {const} */ ("play"), winners: state.winners.slice(0, -1), undoBy: null,
    scoreDetails: remaining };
  if (replayCutoffs) next.replayCutoffs = replayCutoffs;
  if (!remaining.some(detail => detail?.source === "replay")) delete next.replaySeats;
  return next;
}

/** @param {RoomState} state */
function canReportReplay(state) {
  if (state.config.practice || state.vetoCompletedAt === undefined || !state.order.length) return false;
  const keys = state.order.map(map => replayMapKey(state.config.maps[map]));
  return !keys.includes("") && new Set(keys).size === keys.length;
}

/** @param {RoomState} state */
function replayScoreSummary(state) {
  const reports = scoreDetails(state).map(detail => {
    if (detail?.source !== "replay") return null;
    return { submittedBy: detail.submittedBy, confirmed: detail.confirmed };
  });
  return { replayScoring: canReportReplay(state), reports, undoBy: state.undoBy ?? null };
}

/** @param {RoomState} state @returns {RoomState} */
function withoutReplayHistory(state) {
  const manualRoom = { ...state };
  delete manualRoom.vetoCompletedAt;
  delete manualRoom.replaySeats;
  delete manualRoom.scoreDetails;
  delete manualRoom.replayCutoffs;
  delete manualRoom.undoBy;
  return manualRoom;
}

module.exports = { reportReplay, addManualScore, undoScore, replayScoreSummary, withoutReplayHistory };
