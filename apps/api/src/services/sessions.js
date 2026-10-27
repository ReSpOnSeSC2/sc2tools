"use strict";

const MIN_GAP_MINUTES = 15;
const MAX_GAP_MINUTES = 480;
const MAX_DATE_MS = 8_640_000_000_000_000;
const FALLBACK = Object.freeze(["myToonHandle", "opponent.toonHandle", "outcomeRank", "result", "opponent.race", "myMmr"]);

/** Stored date is the replay-END instant, not optional startedAt. This pure
 * normalizer does not widen a DB query or rescue a corpus page excluded by it.
 * @param {unknown} value @returns {number|null} */
function instant(value) {
  if (value instanceof Date) value = value.getTime();
  else if (typeof value === "string") {
    if (!/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
    value = Date.parse(value);
  }
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_DATE_MS ? Math.trunc(value) : null;
}

/** @param {string} value */
function wellFormed(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Unicode scalar order, including NUL; neither locale nor UTF-16 order.
 * @param {string} left @param {string} right */
function codePoints(left, right) {
  const a = left[Symbol.iterator](), b = right[Symbol.iterator]();
  for (;;) {
    const x = a.next(), y = b.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const delta = /** @type {number} */ (x.value.codePointAt(0)) - /** @type {number} */ (y.value.codePointAt(0));
    if (delta) return delta < 0 ? -1 : 1;
  }
}

/** @param {unknown} result @returns {'W'|'L'|'U'} */
function outcome(result) {
  const text = String(result || "").toLowerCase();
  return text === "win" || text === "victory" ? "W" : text === "loss" || text === "defeat" ? "L" : "U";
}

/** @param {Record<string,any>} row @param {string} field @returns {unknown} */
function leaf(row, field) {
  if (field === "outcomeRank") return { U: 0, L: 1, W: 2 }[outcome(row.result)];
  if (field.startsWith("opponent.")) {
    if (row.opponent === null || row.opponent === undefined) return undefined;
    if (typeof row.opponent !== "object" || Array.isArray(row.opponent)) return {};
    return row.opponent[field.slice(9)];
  }
  return row[field];
}

/** Rank/payload shape is fixed. Universal legacy BSON->JSON parity is excluded:
 * Decimal/large Long, nonfinite scalars, Date-in-scalar and malformed Unicode
 * are not silently coerced into supported numbers/strings or excluded as rows.
 * @param {unknown} value @returns {{rank:number,value:number|string|boolean}} */
function descriptor(value) {
  if (value === undefined) return { rank: 0, value: 0 };
  if (value === null) return { rank: 1, value: 0 };
  if (typeof value === "boolean") return { rank: 2, value };
  if (typeof value === "number" && Number.isFinite(value)) return { rank: 3, value: value === 0 ? 0 : value };
  if (typeof value === "string" && wellFormed(value)) return { rank: 4, value };
  return { rank: 5, value: 0 };
}

/** @param {Record<string,any>} row @param {number} time */
function orderKey(row, time) {
  const validId = typeof row.gameId === "string" && row.gameId.length > 0 && wellFormed(row.gameId);
  return { time, idRank: validId ? 0 : 1, id: validId ? row.gameId : "", values: FALLBACK.map(field => descriptor(leaf(row, field))) };
}

/** @param {ReturnType<typeof orderKey>} a @param {ReturnType<typeof orderKey>} b */
function compareKeys(a, b) {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  if (a.idRank !== b.idRank) return a.idRank - b.idRank;
  const id = codePoints(a.id, b.id); if (id) return id;
  for (let i = 0; i < a.values.length; i++) {
    const x = a.values[i], y = b.values[i];
    if (x.rank !== y.rank) return x.rank - y.rank;
    if (x.value === y.value) continue;
    if (x.rank === 4) return codePoints(String(x.value), String(y.value));
    return Number(x.value) < Number(y.value) ? -1 : 1;
  }
  return 0;
}

/** No input mutation/deduplication. Equal supported views retain multiplicity;
 * ordering unrelated cosmetic/build/map fields or object identity is not promised.
 * @template {Record<string,any>} T @param {T[]} games */
function ordered(games) {
  return games.flatMap(game => {
    const time = instant(game.date);
    return time === null ? [] : [{ game, time, key: orderKey(game, time) }];
  }).sort((a, b) => compareKeys(a.key, b.key));
}

/** @param {unknown} value */
function validGap(value) { return typeof value === "number" && Number.isInteger(value) && value >= MIN_GAP_MINUTES && value <= MAX_GAP_MINUTES; }

/** All eligible outcomes bridge before decided statistics. tz labels instants;
 * midnight/DST never split a session. Invalid instants cannot define membership.
 * @template {Record<string,any>} T @param {T[]} games
 * @param {{gapMinutes:number,tz?:string}} opts
 * @returns {Array<{games:T[],start:number,end:number}>} */
function sessionize(games, opts) {
  if (!validGap(opts.gapMinutes)) throw new TypeError("session_gap_invalid");
  /** @type {Array<{games:T[],start:number,end:number}>} */ const sessions = [];
  for (const row of ordered(games)) {
    const previous = sessions.at(-1);
    if (!previous || row.time - previous.end > opts.gapMinutes * 60_000) sessions.push({ games: [row.game], start: row.time, end: row.time });
    else { previous.games.push(row.game); previous.end = row.time; }
  }
  return sessions;
}

/** Fixed object field order; explicit rank precedes canonical payload. Numeric
 * legacy kinds outside the JSON-stable supported domain gain no parity claim.
 * This never projects/drops legacy rows or converts their values to double.
 * @param {string} field @returns {Record<string,any>} */
function mongoDescriptor(field) {
  const type = { $type: field };
  return { $switch: { branches: [
    { case: { $eq: [type, "missing"] }, then: { rank: 0, value: 0 } },
    { case: { $eq: [type, "null"] }, then: { rank: 1, value: 0 } },
    { case: { $eq: [type, "bool"] }, then: { rank: 2, value: field } },
    { case: { $in: [type, ["int", "long", "double"]] }, then: { $cond: [
      { $and: [{ $gte: [field, -Number.MAX_VALUE] }, { $lte: [field, Number.MAX_VALUE] }] },
      { rank: 3, value: field }, { rank: 5, value: 0 },
    ] } },
    { case: { $eq: [type, "string"] }, then: { rank: 4, value: field } },
  ], default: { rank: 5, value: 0 } } };
}

/** @returns {Record<string,any>} */
function mongoOrder() {
  const id = { $cond: [{ $eq: [{ $type: "$gameId" }, "string"] }, { $gt: [{ $strLenBytes: "$gameId" }, 0] }, false] };
  const result = { $cond: [{ $eq: [{ $type: "$result" }, "string"] }, { $toLower: "$result" }, ""] };
  const rank = { $switch: { branches: [
    { case: { $in: [result, ["loss", "defeat"]] }, then: 1 },
    { case: { $in: [result, ["win", "victory"]] }, then: 2 },
  ], default: 0 } };
  return { time: { $toLong: "$date" }, idRank: { $cond: [id, 0, 1] }, id: { $cond: [id, "$gameId", ""] },
    f0: mongoDescriptor("$myToonHandle"), f1: mongoDescriptor("$opponent.toonHandle"),
    f2: { rank: 3, value: rank }, f3: mongoDescriptor("$result"),
    f4: mongoDescriptor("$opponent.race"), f5: mongoDescriptor("$myMmr") };
}

module.exports = { sessionize, ordered, instant, outcome, codePoints, wellFormed, validGap, mongoOrder, MIN_GAP_MINUTES, MAX_GAP_MINUTES, MAX_DATE_MS };
