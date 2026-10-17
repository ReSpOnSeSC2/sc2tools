"use strict";

const PREFIX = "ae1.";

/** @param {{createdAt: Date, eventId: string}} event */
function adminEventCursor(event) {
  return PREFIX + Buffer.from(JSON.stringify({
    date: event.createdAt.toISOString(), eventId: event.eventId,
  })).toString("base64url");
}

/**
 * Use the event id to keep events sharing a millisecond traversable.
 * Legacy date-only bookmarks retain their original strictly-before meaning.
 * @param {unknown} before
 * @returns {Record<string, any>}
 */
function adminEventPageFilter(before) {
  if (before instanceof Date) {
    return Number.isNaN(before.getTime()) ? {} : { createdAt: { $lt: before } };
  }
  if (typeof before !== "string" || !before) return {};
  if (!before.startsWith(PREFIX)) {
    const date = new Date(before);
    return Number.isNaN(date.getTime()) ? {} : { createdAt: { $lt: date } };
  }
  try {
    const encoded = before.slice(PREFIX.length);
    if (before.length > 1024 || !/^[a-zA-Z0-9_-]+$/.test(encoded)) throw new Error();
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const date = typeof value.date === "string" ? new Date(value.date) : new Date(NaN);
    if (Number.isNaN(date.getTime()) || typeof value.eventId !== "string"
      || !value.eventId || value.eventId.length > 128) throw new Error();
    return { $or: [
      { createdAt: { $lt: date } },
      { createdAt: date, eventId: { $lt: value.eventId } },
    ] };
  } catch {
    throw Object.assign(new Error("invalid_admin_events_cursor"), {
      status: 400, code: "invalid_admin_events_cursor",
    });
  }
}

module.exports = { adminEventCursor, adminEventPageFilter };
