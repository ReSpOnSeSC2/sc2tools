"use strict";

const { createHash } = require("crypto");
const { parseBuildLogLines } = require("./perGameCompute");
const { isFinishTimeEvent } = require("./buildDurations");

const MAX_STEPS = 250;
const MAX_TIME = 14400;
const MAX_REFERENCES = 32;
const MATCHUPS = new Set(["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ"]);
const WORKERS = new Set(["scv", "probe", "drone", "mule", "larva"]);

/** @param {string} code @param {number} [status] */
function failure(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

/** @param {unknown} raw @param {number} limit @param {boolean} [required] */
function text(raw, limit, required = false) {
  if (raw === undefined && !required) return "";
  if (typeof raw !== "string" || raw.length > limit || /[\u0000-\u001f\u007f]/.test(raw)) throw failure("invalid_ghost_text");
  const clean = raw.trim();
  if (required && !clean) throw failure("invalid_ghost_text");
  return clean;
}

/** @param {unknown} raw */
function race(raw) {
  const value = typeof raw === "string" ? raw.toLowerCase() : "";
  return /** @type {Record<string,string>} */ ({ p: "P", protoss: "P", t: "T", terran: "T", z: "Z", zerg: "Z" })[value] || null;
}

/** @param {unknown} raw */
function sideOf(raw) {
  if (raw === undefined || raw === "you") return "you";
  if (raw === "opponent") return "opponent";
  throw failure("invalid_ghost_side");
}

/** @param {string} value */
function digest(value) { return createHash("sha256").update(value).digest("hex"); }

/** @param {any} raw */
function normalizeTarget(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.v !== 1) throw failure("invalid_ghost_target");
  const name = text(raw.name, 80, true);
  const sourceGameId = text(raw.sourceGameId, 128, true);
  if (!Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length > MAX_STEPS) throw failure("invalid_ghost_steps");
  const steps = raw.steps.map((/** @type {any} */ step) => {
    if (!step || typeof step !== "object" || !Number.isFinite(step.t) || step.t < 0 || step.t > MAX_TIME) throw failure("invalid_ghost_step");
    if (step.supply != null && (!Number.isFinite(step.supply) || step.supply < 0 || step.supply > 200)) throw failure("invalid_ghost_step");
    const stepName = text(step.name, 48, true);
    if (!/^[A-Za-z][A-Za-z0-9 _-]*$/.test(stepName)) throw failure("invalid_ghost_step");
    const kind = ["building", "unit", "upgrade", "other"].includes(step.kind) ? step.kind : "other";
    const timing = ["started", "completed", "recorded"].includes(step.timing) ? step.timing : "recorded";
    return { name: stepName, t: step.t, supply: step.supply ?? null, kind, timing };
  }).sort((/** @type {any} */ first, /** @type {any} */ second) => first.t - second.t);
  const perspective = sideOf(raw.perspective);
  return { v: 1, name, sourceGameId, perspective, steps };
}

/** @param {any} game @param {string[]} lines @param {string} side */
function targetFromReplay(game, lines, side) {
  const ownerRace = race(game.myRace);
  const otherRace = race(game.opponent?.race || game.oppRace);
  if (!ownerRace || !otherRace || (game.playerCount != null && game.playerCount !== 2) || (game.matchFormat != null && game.matchFormat !== "1v1") || game.isResumedFromReplay === true) throw failure("ghost_matchup_unavailable", 409);
  const myRace = side === "opponent" ? otherRace : ownerRace;
  const opponentRace = side === "opponent" ? ownerRace : otherRace;
  const build = side === "opponent" ? game.opponent?.strategy || game.opp_strategy : game.myBuild;
  const name = typeof build === "string" && build.trim() ? build.trim().slice(0, 80) : `${myRace}v${opponentRace} replay opening`;
  const valid = lines.slice(0, 5000).filter((line) => typeof line === "string" && line.length <= 200 && /^\[\d+:[0-5]\d\]\s+[A-Za-z][A-Za-z0-9]*\s*$/.test(line));
  const duration = Number.isFinite(game.durationSec) && game.durationSec >= 0 ? Math.min(game.durationSec, MAX_TIME) : MAX_TIME;
  const steps = parseBuildLogLines(valid, null).filter((event) => event.time <= duration && !WORKERS.has(event.name.toLowerCase()) && event.name.length <= 48).slice(0, MAX_STEPS).map((event) => ({
    name: event.name, t: event.time, supply: null,
    kind: event.is_building ? "building" : event.category === "upgrade" ? "upgrade" : "unit",
    timing: isFinishTimeEvent(event.name, { isBuilding: event.is_building, category: event.category }) ? "completed" : "started",
  }));
  if (!steps.length) throw failure("ghost_build_order_unavailable", 409);
  const sourceGameId = String(game.gameId).length <= 128 ? String(game.gameId) : "replay:" + digest(String(game.gameId));
  return { matchup: `${myRace}v${opponentRace}`, myRace, opponentRace, buildKey: typeof build === "string" && build.trim() ? build.trim().slice(0, 160) : name, target: normalizeTarget({ v: 1, name, sourceGameId, perspective: side, steps }) };
}

/** @param {any} db @param {any} gameDetails @param {string} owner @param {string} gameId @param {string} side */
async function ownedReplayTarget(db, gameDetails, owner, gameId, side) {
  const game = await db.games.findOne({ userId: owner, gameId }, { projection: {
    _id: 0, gameId: 1, myRace: 1, myBuild: 1, oppRace: 1, opp_strategy: 1,
    "opponent.race": 1, "opponent.strategy": 1, durationSec: 1, map: 1,
    playerCount: 1, matchFormat: 1, result: 1, isResumedFromReplay: 1, buildLog: 1, oppBuildLog: 1,
  } });
  if (!game) throw failure("ghost_replay_not_found", 404);
  const field = side === "opponent" ? "oppBuildLog" : "buildLog";
  const detail = !Array.isArray(game[field]) && gameDetails ? await gameDetails.findOne(owner, gameId, { fields: [field] }) : null;
  const lines = Array.isArray(game[field]) ? game[field] : detail?.[field];
  if (!Array.isArray(lines)) throw failure("ghost_build_order_unavailable", 409);
  return { ...targetFromReplay(game, lines, side), game };
}

module.exports = { MAX_STEPS, MAX_REFERENCES, MATCHUPS, failure, text, sideOf, digest, normalizeTarget, ownedReplayTarget };
