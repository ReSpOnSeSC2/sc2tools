"use strict";

// Only recordings with all authoritative channels qualify. A partial export,
// old movement-only recording, or unverified fidelity claim must not become
// sticky. A new complete recording is always allowed to replace an old one.
/** @param {any} value */
function completeRecordedPlayback(value) {
  const f = value?.fidelity;
  return Boolean(value && Number.isInteger(value.v) && value.v >= 6 && value.v <= 10 &&
    typeof value.mapName === "string" && value.mapName.length > 0 &&
    Number.isFinite(value.gameLength) && value.gameLength > 0 && value.gameLength <= 86400 &&
    f?.positions === "engine" && f.paths === "observed" && f.complete === true &&
    ["attacks", "effects", "creep"].every(key => f[key] === "observed") &&
    Number.isFinite(f.sampleSeconds) && f.sampleSeconds > 0 && f.sampleSeconds <= 0.179 &&
    Number.isFinite(f.positionError) && f.positionError >= 0 && f.positionError <= 0.5 &&
    Array.isArray(value.units) && value.units.length > 0 && Array.isArray(value.buildings) &&
    Array.isArray(value.effects) && value.creep?.encoding === "rle" &&
    Number.isInteger(value.creep.width) && value.creep.width > 0 && value.creep.width <= 512 &&
    Number.isInteger(value.creep.height) && value.creep.height > 0 && value.creep.height <= 512 &&
    Array.isArray(value.creep.frames) && value.creep.frames.length > 0 &&
    (value.replaySha256 === undefined || validHash(value.replaySha256)));
}

/** @param {any} value */
function validHash(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }

/** @param {any} current @param {any} incoming */
function preserveRecordedPlayback(current, incoming) {
  if (!completeRecordedPlayback(current) || completeRecordedPlayback(incoming)) return false;
  if (validHash(current.replaySha256) && validHash(incoming?.replaySha256) && current.replaySha256 !== incoming.replaySha256) return false;
  for (const key of ["mapName", "gameLength"]) {
    if (incoming?.[key] !== undefined && incoming[key] !== current[key]) return false;
  }
  return true;
}

/** Mongo must evaluate against the row at the instant it updates, rather
 * than a preceding application read that could race a complete recording.
 * This expression mirrors completeRecordedPlayback's bounded fidelity check.
 * @param {any} incoming */
function mongoPlaybackReplacement(incoming) {
  if (completeRecordedPlayback(incoming)) return { $literal: incoming };
  const field = (/** @type {string} */ path) => `$mapPlayback.${path}`;
  const equal = (/** @type {string} */ path, /** @type {any} */ value) => ({ $eq: [field(path), { $literal: value }] });
  const range = (/** @type {string} */ path, /** @type {number} */ low, /** @type {number} */ high, exclusive = false) => ({
    $and: [{ $isNumber: field(path) }, { [exclusive ? "$gt" : "$gte"]: [field(path), low] }, { $lte: [field(path), high] }],
  });
  const integer = (/** @type {string} */ path) => ({ $eq: [
    { $mod: [{ $cond: [{ $isNumber: field(path) }, field(path), 0.5] }, 1] }, 0,
  ] });
  const nonempty = (/** @type {string} */ path) => ({ $gt: [{ $size: { $cond: [{ $isArray: field(path) }, field(path), []] } }, 0] });
  /** @type {any[]} */
  const conditions = [integer("v"), range("v", 6, 10), equal("fidelity.positions", "engine"),
    equal("fidelity.paths", "observed"), equal("fidelity.complete", true),
    ...["attacks", "effects", "creep"].map(key => equal(`fidelity.${key}`, "observed")),
    range("fidelity.sampleSeconds", 0, 0.179, true), range("fidelity.positionError", 0, 0.5),
    { $eq: [{ $type: field("mapName") }, "string"] }, { $ne: [field("mapName"), ""] },
    range("gameLength", 0, 86400, true), nonempty("units"), { $isArray: field("buildings") },
    { $isArray: field("effects") }, equal("creep.encoding", "rle"),
    integer("creep.width"), range("creep.width", 1, 512), integer("creep.height"), range("creep.height", 1, 512), nonempty("creep.frames"),
  ];
  const hashMissing = { $eq: [{ $type: field("replaySha256") }, "missing"] };
  conditions.push({ $or: [hashMissing, { $regexMatch: {
    input: { $convert: { input: field("replaySha256"), to: "string", onError: "", onNull: "" } }, regex: "^[a-f0-9]{64}$",
  } }] });
  if (validHash(incoming?.replaySha256)) conditions.push({ $or: [hashMissing, equal("replaySha256", incoming.replaySha256)] });
  for (const key of ["mapName", "gameLength"]) if (incoming?.[key] !== undefined) conditions.push(equal(key, incoming[key]));
  return { $cond: [{ $and: conditions }, "$mapPlayback", { $literal: incoming }] };
}

module.exports = { completeRecordedPlayback, preserveRecordedPlayback, mongoPlaybackReplacement };
