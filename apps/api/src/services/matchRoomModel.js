"use strict";

const { cleanDisplayName, containsBlockedTerm } = require("../util/contentFilter");
const { sha256 } = require("../util/hash");
const { FORMATS, MAX_SERIES_MAPS } = require("./streamSeriesModel");

const PRESETS = ["standard", "pick-first", "ban-only"];
const TURN_MS = 30_000;

/** @typedef {"a"|"b"} Seat */
/** @typedef {"ban"|"pick"} MoveKind */
/** @typedef {"host"|Seat|"watch"} Role */
/** @typedef {{format: number, preset: string, maps: string[], practice: boolean}} RoomConfig */
/** @typedef {{seat: Seat, kind: MoveKind, map: number, automatic: boolean}} Move */
/** @typedef {{seat: Seat, kind: MoveKind}} Step */
/** @typedef {{config: RoomConfig, seed: string, first: Seat, phase: "lobby"|"veto"|"play"|"complete",
 * names: Record<Seat, string>, ready: Record<Seat, boolean>, steps: Step[], moves: Move[],
 * order: number[], winners: Seat[], deadline: number|null}} RoomState */

class MatchRoomError extends Error {
  /** @param {number} status @param {string} code */
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {number} max @param {string} code */
function label(value, max, code) {
  if (typeof value !== "string" || value.length > max || /[<>]/u.test(value)) {
    throw new MatchRoomError(400, code);
  }
  const cleaned = cleanDisplayName(value);
  if (containsBlockedTerm(cleaned)) throw new MatchRoomError(400, code);
  return cleaned;
}

/** @param {unknown} value @returns {RoomConfig} */
function roomConfig(value) {
  const options = readRoomOptions(value);
  const maps = options.maps.map(map => label(map, 48, "invalid_map"));
  const keys = new Set(maps.map(map => map.normalize("NFKC").toLowerCase()));
  if (maps.includes("") || keys.size !== maps.length) throw new MatchRoomError(400, "invalid_map");
  return { ...options, maps };
}

/** @param {unknown} value */
function readRoomOptions(value) {
  if (!isRecord(value) || typeof value.format !== "number" || !FORMATS.includes(value.format)
    || typeof value.preset !== "string" || !PRESETS.includes(value.preset) || typeof value.practice !== "boolean") {
    throw new MatchRoomError(400, "invalid_room");
  }
  const { format, preset, practice, maps } = value;
  if (!Array.isArray(maps) || maps.length < format || maps.length > MAX_SERIES_MAPS) {
    throw new MatchRoomError(400, "invalid_room");
  }
  return { format, preset, practice, maps: /** @type {unknown[]} */ (maps) };
}

/** @param {unknown} value @returns {value is Seat} */
function isSeat(value) {
  return value === "a" || value === "b";
}

/** @param {Seat} seat @returns {Seat} */
function otherSeat(seat) {
  return seat === "a" ? "b" : "a";
}

/** @param {string} seed @param {string} context */
function draw(seed, context) {
  return Number.parseInt(sha256(seed + ":" + context).slice(0, 12), 16);
}

/** @param {RoomConfig} config @param {Seat} first */
function vetoSteps(config, first) {
  const bans = config.maps.length - config.format;
  const picks = config.preset === "ban-only" ? 0 : config.format - 1;
  /** @type {MoveKind[]} */
  const kinds = [...Array(bans).fill("ban"), ...Array(picks).fill("pick")];
  if (config.preset === "pick-first") kinds.reverse();
  return kinds.map((kind, index) => ({ kind, seat: index % 2 === 0 ? first : otherSeat(first) }));
}

/** @param {RoomConfig} config @param {string} seed @returns {RoomState} */
function initialRoom(config, seed) {
  const first = draw(seed, "coin") % 2 === 0 ? "a" : "b";
  return { config, seed, first, phase: "lobby", names: { a: "", b: "" }, ready: { a: false, b: false },
    steps: vetoSteps(config, first), moves: [], order: [], winners: [], deadline: null };
}

/** @param {RoomState} state */
function availableMaps(state) {
  const used = new Set(state.moves.map(move => move.map));
  return state.config.maps.map((_, index) => index).filter(index => !used.has(index));
}

/** @param {RoomState} state @returns {RoomState} */
function openScoring(state) {
  const picks = state.moves.filter(move => move.kind === "pick").map(move => move.map);
  const remaining = availableMaps(state)
    .map(map => ({ map, rank: draw(state.seed, "order:" + map) }))
    .sort((a, b) => a.rank - b.rank || a.map - b.map);
  return { ...state, phase: "play", order: [...picks, ...remaining.map(({ map }) => map)], deadline: null };
}

/** @param {RoomState} state @param {number} map @param {number} now @param {boolean} automatic */
function addMove(state, map, now, automatic) {
  const step = state.steps[state.moves.length];
  const next = { ...state, moves: [...state.moves, { ...step, map, automatic }], deadline: now + TURN_MS };
  return next.moves.length === next.steps.length ? openScoring(next) : next;
}

/** @param {RoomState} state @param {number} now */
function advanceExpiredTurns(state, now) {
  let next = state;
  while (next.deadline !== null && next.deadline <= now) {
    const maps = availableMaps(next);
    const map = maps[draw(next.seed, "timeout:" + next.moves.length) % maps.length];
    next = addMove(next, map, next.deadline, true);
  }
  return next;
}

/** @param {RoomState} state @param {Role} role @param {unknown} as */
function actingSeat(state, role, as) {
  if (isSeat(role)) return role;
  if (state.config.practice && role === "host" && isSeat(as)) return as;
  throw new MatchRoomError(403, "seat_required");
}

/** @param {RoomState} state @param {Seat} seat @param {unknown} value @param {number} now @returns {RoomState} */
function setReady(state, seat, value, now) {
  if (state.phase !== "lobby" || typeof value !== "boolean") throw new MatchRoomError(400, "invalid_ready");
  const next = { ...state, ready: { ...state.ready, [seat]: value } };
  if (!next.ready.a || !next.ready.b) return next;
  return next.steps.length > 0 ? { ...next, phase: "veto", deadline: now + TURN_MS } : openScoring(next);
}

/** @param {RoomState} state @param {Seat} seat @param {unknown} map @param {number} now */
function takeTurn(state, seat, map, now) {
  const step = state.steps[state.moves.length];
  if (state.phase !== "veto" || step?.seat !== seat) throw new MatchRoomError(409, "turn_changed");
  if (typeof map !== "number" || !availableMaps(state).includes(map)) {
    throw new MatchRoomError(400, "invalid_map");
  }
  return addMove(state, map, now, false);
}

/** @param {RoomState} state */
function roomScore(state) {
  const a = state.winners.filter(seat => seat === "a").length;
  return { a, b: state.winners.length - a };
}

/** @param {RoomState} state @param {unknown} winner @returns {RoomState} */
function recordGame(state, winner) {
  if (state.phase !== "play" || !isSeat(winner)) throw new MatchRoomError(409, "score_changed");
  const next = { ...state, winners: [...state.winners, winner] };
  const finished = roomScore(next)[winner] > state.config.format / 2;
  return finished ? { ...next, phase: "complete" } : next;
}

/** @param {RoomState} state @param {Role} role @param {unknown} action @param {number} now @returns {RoomState} */
function reduceMatchRoom(state, role, action, now) {
  if (role === "watch") throw new MatchRoomError(403, "seat_required");
  if (!isRecord(action)) throw new MatchRoomError(400, "invalid_room_action");
  switch (action.type) {
    case "name": {
      const seat = actingSeat(state, role, action.as);
      return { ...state, names: { ...state.names, [seat]: label(action.value, 24, "invalid_seat_name") } };
    }
    case "ready":
      return setReady(state, actingSeat(state, role, action.as), action.value, now);
    case "veto":
      return takeTurn(state, actingSeat(state, role, action.as), action.map, now);
    case "score":
      return recordGame(state, action.winner);
    case "undo":
      if (role === "host" && state.winners.length) {
        return { ...state, phase: "play", winners: state.winners.slice(0, -1) };
      }
      break;
    default:
      break;
  }
  throw new MatchRoomError(400, "invalid_room_action");
}

/** @param {RoomState} state @param {number} rev @param {Date} expiresAt @param {number} now */
function roomSnapshot(state, rev, expiresAt, now) {
  const { config, names, ready, first, moves, order, winners, phase, deadline } = state;
  return { config, rev, expiresAt: expiresAt.getTime(), serverTime: now, names, ready, first, moves,
    order, winners, phase, deadline, score: roomScore(state),
    turn: phase === "veto" ? state.steps[moves.length] : null };
}

module.exports = { MatchRoomError, roomConfig, initialRoom, advanceExpiredTurns, reduceMatchRoom, roomSnapshot };
