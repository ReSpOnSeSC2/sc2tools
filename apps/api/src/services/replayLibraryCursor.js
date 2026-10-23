"use strict";

const { ObjectId } = require("mongodb");
const REPLAY_LIBRARY_CURSOR_MAX_CHARS = 512;

/**
 * Cursor v2 preserves the raw sortable BSON date type. Historical imports can
 * carry ISO strings, numeric epochs, or null; explicit lower-type branches
 * keep pagination gap-free when a page crosses one of those cohorts.
 *
 * @param {unknown} raw
 * @returns {{dateType:'date'|'string'|'number'|'null',date:Date|string|number|null,id:import('mongodb').ObjectId,sort:'date_asc'|'date_desc'}|null}
 */
function decodeReplayLibraryCursor(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.length > REPLAY_LIBRARY_CURSOR_MAX_CHARS) {
    throw invalidReplayLibraryCursor();
  }
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      !parsed
      || parsed.v !== 3
      || (parsed.s !== "date_asc" && parsed.s !== "date_desc")
    ) {
      throw invalidReplayLibraryCursor();
    }
    const idText = typeof parsed.i === "string" ? parsed.i.toLowerCase() : "";
    if (
      !ObjectId.isValid(idText)
      || new ObjectId(idText).toHexString() !== idText
    ) {
      throw invalidReplayLibraryCursor();
    }
    const decodedDate = decodeCursorDate(parsed.t, parsed.d);
    const sort = /** @type {'date_asc'|'date_desc'} */ (parsed.s);
    return { ...decodedDate, id: new ObjectId(idText), sort };
  } catch (err) {
    const known = /** @type {{code?:unknown}|null} */ (
      err && typeof err === "object" ? err : null
    );
    if (known && known.code === "bad_request") {
      throw err;
    }
    throw invalidReplayLibraryCursor();
  }
}

/** @param {unknown} date @param {unknown} id @param {'date_asc'|'date_desc'} [sort] @returns {string} */
function encodeReplayLibraryCursor(date, id, sort = "date_desc") {
  const encodedDate = encodeCursorDate(date);
  const objectId = id instanceof ObjectId ? id : new ObjectId(String(id));
  return Buffer.from(
    JSON.stringify({
      v: 3,
      s: sort === "date_asc" ? "date_asc" : "date_desc",
      t: encodedDate.dateType,
      d: encodedDate.value,
      i: objectId.toHexString(),
    }),
    "utf8",
  ).toString("base64url");
}

/** @param {{dateType:'date'|'string'|'number'|'null',date:Date|string|number|null,id:import('mongodb').ObjectId,sort:'date_asc'|'date_desc'}} cursor */
function replayCursorContinuationBranches(cursor) {
  if (cursor.sort === "date_asc") return replayCursorHigherBranches(cursor);
  if (cursor.dateType === "null") {
    return [{ date: null, _id: { $lt: cursor.id } }];
  }
  return [
    { date: { $lt: cursor.date } },
    { date: cursor.date, _id: { $lt: cursor.id } },
    ...lowerDateTypeBranches(cursor.dateType),
    { date: null },
  ];
}

/** @param {{dateType:'date'|'string'|'number'|'null',date:Date|string|number|null,id:import('mongodb').ObjectId}} cursor */
function replayCursorHigherBranches(cursor) {
  if (cursor.dateType === "null") {
    return [
      { date: null, _id: { $gt: cursor.id } },
      ...higherDateTypeBranches("null"),
    ];
  }
  return [
    { date: { $gt: cursor.date } },
    { date: cursor.date, _id: { $gt: cursor.id } },
    ...higherDateTypeBranches(cursor.dateType),
  ];
}

/** @param {'date'|'string'|'number'} dateType */
function lowerDateTypeBranches(dateType) {
  const numbers = { date: { $type: ["double", "int", "long", "decimal"] } };
  if (dateType === "date") return [{ date: { $type: "string" } }, numbers];
  if (dateType === "string") return [numbers];
  return [];
}

/** @param {'date'|'string'|'number'|'null'} dateType */
function higherDateTypeBranches(dateType) {
  const numbers = { date: { $type: ["double", "int", "long", "decimal"] } };
  if (dateType === "null") {
    return [numbers, { date: { $type: "string" } }, { date: { $type: "date" } }];
  }
  if (dateType === "number") {
    return [{ date: { $type: "string" } }, { date: { $type: "date" } }];
  }
  if (dateType === "string") return [{ date: { $type: "date" } }];
  return [];
}

/**
 * @param {unknown} rawType
 * @param {unknown} rawValue
 * @returns {{dateType:'date',date:Date}|{dateType:'string',date:string}|{dateType:'number',date:number}|{dateType:'null',date:null}}
 */
function decodeCursorDate(rawType, rawValue) {
  if (rawType === "date" && typeof rawValue === "string") {
    const value = validDate(rawValue);
    if (value) return { dateType: "date", date: value };
  } else if (rawType === "string" && typeof rawValue === "string") {
    return { dateType: "string", date: rawValue };
  } else if (rawType === "number" && Number.isFinite(rawValue)) {
    return { dateType: "number", date: Number(rawValue) };
  } else if (rawType === "null" && rawValue === null) {
    return { dateType: "null", date: null };
  }
  throw invalidReplayLibraryCursor();
}

/** @param {unknown} raw */
function encodeCursorDate(raw) {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return { dateType: "date", value: raw.toISOString() };
  }
  if (typeof raw === "string") return { dateType: "string", value: raw };
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { dateType: "number", value: raw };
  }
  if (raw === null || raw === undefined) {
    return { dateType: "null", value: null };
  }
  throw new Error("replay_library_cursor_date_invalid");
}

/** @returns {Error & {status:number,code:string}} */
function invalidReplayLibraryCursor() {
  const error = /** @type {Error & {status:number,code:string}} */ (
    new Error("invalid replay library cursor")
  );
  error.status = 400;
  error.code = "bad_request";
  return error;
}

/** @param {unknown} raw @returns {Date|null} */
function validDate(raw) {
  let value;
  if (raw instanceof Date) {
    value = new Date(raw.getTime());
  } else if (typeof raw === "string" || typeof raw === "number") {
    value = new Date(raw);
  } else {
    return null;
  }
  return Number.isNaN(value.getTime()) ? null : value;
}

/** Shared BSON date/_id comparator for archive and future owner game navigation.
 * @param {unknown} date @param {unknown} id @param {"date_asc"|"date_desc"} sort */
function replayNeighborBranches(date, id, sort) {
  const encoded = encodeCursorDate(date);
  const position = decodeCursorDate(encoded.dateType, encoded.value);
  const objectId = id instanceof ObjectId ? id : new ObjectId(String(id));
  return replayCursorContinuationBranches({ ...position, id: objectId, sort });
}

module.exports = { decodeReplayLibraryCursor, encodeReplayLibraryCursor, replayCursorContinuationBranches, replayNeighborBranches, invalidReplayLibraryCursor };
