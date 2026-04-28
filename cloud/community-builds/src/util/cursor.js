"use strict";

/**
 * Pagination cursor encoding helpers.
 * The cursor encodes the last seen sort key and id, base64url.
 *
 * Example:
 *   const cursor = encodeCursor({ updatedAt: 123, id: "x" });
 *   const parsed = decodeCursor(cursor);
 */

/**
 * @param {{ updatedAt: number, id: string } | null} payload
 * @returns {string|null}
 */
function encodeCursor(payload) {
  if (!payload) return null;
  const json = JSON.stringify(payload);
  return Buffer.from(json, "utf8").toString("base64url");
}

/**
 * @param {string|undefined|null} cursor
 * @returns {{ updatedAt: number, id: string } | null}
 */
function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== "string") return null;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (typeof parsed?.updatedAt !== "number" || typeof parsed?.id !== "string") {
      return null;
    }
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    return null;
  }
}

module.exports = { encodeCursor, decodeCursor };
