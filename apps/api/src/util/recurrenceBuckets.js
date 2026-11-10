"use strict";

/**
 * Recurrence buckets: local-calendar windows in an IANA timezone, without a
 * date library. Shared by coaching practice assignments
 * (services/coaching.js) and personal goals (services/playerGoals.js), so a
 * "weekly" window means the same Monday-to-Monday local week in both, and
 * DST transitions resolve identically.
 *
 * A requirement is ``{recurrence, timeZone, startsOn, endsOn, startsAt,
 * endsAt}``: inclusive local dates (YYYY-MM-DD) plus their exclusive UTC
 * window. ``recurrenceBuckets`` expands it into concrete UTC slices keyed
 * the way ``bucketKeyFor`` keys a ``$dateTrunc`` group row, so aggregation
 * counts join bucket summaries without timezone math in Mongo output.
 *
 * Errors carry ``reason``: "bad_date" for malformed input (a 400 for the
 * caller) and "unresolved" when stored dates cannot be resolved in the zone
 * (a 500: never expected after validation). Callers map them to their own
 * error codes.
 */

/** @typedef {"once" | "daily" | "weekly" | "monthly"} Recurrence */
/** @typedef {{year:number, month:number, day:number}} PlainDate */
/**
 * @typedef {{
 *   recurrence: string,
 *   timeZone?: string | null,
 *   startsOn: string,
 *   endsOn: string,
 *   startsAt: Date | string,
 *   endsAt: Date | string,
 * }} RecurrenceRequirement
 */
/** @typedef {{key: string, startsAt: string | null, endsAt: string | null}} RecurrenceBucket */

const RECURRENCES = Object.freeze(["once", "daily", "weekly", "monthly"]);
const DAY_MS = 86_400_000;

/** @type {Map<string, Intl.DateTimeFormat>} */
const ZONE_PART_FORMATTERS = new Map();

/**
 * @param {"bad_date" | "unresolved"} reason
 * @param {string} message
 */
function recurrenceError(reason, message) {
  return Object.assign(new Error(message), { reason });
}

/**
 * Canonical IANA zone name, or null when the runtime does not know it.
 *
 * Example: `canonicalTimeZone("europe/london")` → "Europe/London".
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function canonicalTimeZone(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value })
      .resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}

/**
 * Local wall-clock parts of an instant in a zone. Formatters are cached per
 * zone: constructing Intl formatters is the expensive part.
 *
 * @param {Date} value
 * @param {string} timeZone
 */
function zonedParts(value, timeZone) {
  let formatter = ZONE_PART_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    ZONE_PART_FORMATTERS.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(value);
  /** @type {Record<string,number>} */
  const out = {};
  for (const part of parts) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return /** @type {{year:number,month:number,day:number,hour:number,minute:number,second:number}} */ (out);
}

/**
 * Convert an IANA-zone local wall-clock value to UTC. Two offset passes
 * handle DST boundaries; a final round-trip rejects local times that do not
 * exist during a spring-forward transition. With ``nextValidOnDate`` a
 * skipped local time resolves to the first valid instant later that same
 * local date (zones that move clocks at midnight).
 *
 * Example: `zonedLocalToUtc(2026, 3, 8, 0, "America/New_York")` →
 * 2026-03-08T05:00:00.000Z.
 *
 * @param {number} year @param {number} month @param {number} day
 * @param {number} minuteOfDay @param {string} timeZone
 * @param {boolean} [nextValidOnDate]
 * @returns {Date | null}
 */
function zonedLocalToUtc(year, month, day, minuteOfDay, timeZone, nextValidOnDate = false) {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = new Date(wall);
  for (let i = 0; i < 3; i += 1) {
    const seen = zonedParts(candidate, timeZone);
    const seenWall = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second || 0);
    const delta = wall - seenWall;
    if (delta === 0) break;
    candidate = new Date(candidate.getTime() + delta);
  }
  const roundTrip = zonedParts(candidate, timeZone);
  if (
    nextValidOnDate
    && roundTrip.year === year
    && roundTrip.month === month
    && roundTrip.day === day
    && roundTrip.hour * 60 + roundTrip.minute > minuteOfDay
  ) return candidate;
  if (roundTrip.year !== year || roundTrip.month !== month || roundTrip.day !== day || roundTrip.hour !== hour || roundTrip.minute !== minute) {
    return null;
  }
  return candidate;
}

/**
 * Parse an inclusive local date. Throws a "bad_date" error naming ``field``.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {PlainDate}
 */
function parsePlainDate(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw recurrenceError("bad_date", `${field} must use YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const serial = new Date(Date.UTC(year, month - 1, day));
  if (
    serial.getUTCFullYear() !== year
    || serial.getUTCMonth() + 1 !== month
    || serial.getUTCDate() !== day
  ) {
    throw recurrenceError("bad_date", `${field} is not a valid calendar date.`);
  }
  return { year, month, day };
}

/** @param {PlainDate} value */
function plainDateSerial(value) {
  return Date.UTC(value.year, value.month - 1, value.day);
}

/** @param {PlainDate} value @param {number} days @returns {PlainDate} */
function addPlainDays(value, days) {
  const date = new Date(plainDateSerial(value) + days * DAY_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/** @param {PlainDate} value */
function plainDateString(value) {
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

/** @param {unknown} value */
function toDate(value) {
  const date = value instanceof Date ? value : new Date(/** @type {any} */ (value));
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

/** @param {unknown} value */
function isoOrNull(value) {
  const date = toDate(value);
  return date.getTime() > 0 ? date.toISOString() : null;
}

/**
 * Inclusive local dates → their exclusive UTC window (local midnight of
 * ``startsOn`` to local midnight after ``endsOn``). Null when a boundary
 * cannot be resolved in the zone or the window is empty.
 *
 * Example: `localWindow("2026-03-08", "2026-03-08", "America/New_York")` →
 * {startsAt: 2026-03-08T05:00Z, endsAt: 2026-03-09T04:00Z} (a 23-hour day).
 *
 * @param {PlainDate} start @param {PlainDate} end @param {string} timeZone
 * @returns {{startsAt: Date, endsAt: Date} | null}
 */
function localWindow(start, end, timeZone) {
  const endExclusive = addPlainDays(end, 1);
  const startsAt = zonedLocalToUtc(start.year, start.month, start.day, 0, timeZone, true);
  const endsAt = zonedLocalToUtc(endExclusive.year, endExclusive.month, endExclusive.day, 0, timeZone, true);
  if (!startsAt || !endsAt || endsAt <= startsAt) return null;
  return { startsAt, endsAt };
}

/**
 * Expand a requirement into its UTC buckets: one "once" bucket, or each
 * local day / Monday-start week / calendar month intersecting the window,
 * clipped to it. Throws "bad_date" for malformed stored dates and
 * "unresolved" when a boundary cannot be resolved in the zone.
 *
 * Example: weekly from Wed 2026-03-04 to Sun 2026-03-15 in America/New_York
 * → keys "2026-03-02" (clipped to start Wed) and "2026-03-09" (spans the
 * DST change, 167 hours long).
 *
 * @param {RecurrenceRequirement} requirement
 * @returns {RecurrenceBucket[]}
 */
function recurrenceBuckets(requirement) {
  const timeZone = canonicalTimeZone(requirement.timeZone) || "UTC";
  const start = parsePlainDate(requirement.startsOn, "startsOn");
  const end = parsePlainDate(requirement.endsOn, "endsOn");
  const endExclusive = addPlainDays(end, 1);
  if (requirement.recurrence === "once") {
    return [{
      key: "once",
      startsAt: isoOrNull(requirement.startsAt),
      endsAt: isoOrNull(requirement.endsAt),
    }];
  }

  let cursor = start;
  let step = 1;
  if (requirement.recurrence === "weekly") {
    const day = new Date(plainDateSerial(start)).getUTCDay();
    cursor = addPlainDays(start, -((day + 6) % 7));
    step = 7;
  } else if (requirement.recurrence === "monthly") {
    cursor = { year: start.year, month: start.month, day: 1 };
  }
  const windowStart = toDate(requirement.startsAt);
  const windowEnd = toDate(requirement.endsAt);
  /** @type {RecurrenceBucket[]} */
  const out = [];
  while (plainDateSerial(cursor) < plainDateSerial(endExclusive)) {
    let next;
    let key;
    if (requirement.recurrence === "monthly") {
      next = cursor.month === 12
        ? { year: cursor.year + 1, month: 1, day: 1 }
        : { year: cursor.year, month: cursor.month + 1, day: 1 };
      key = plainDateString(cursor).slice(0, 7);
    } else {
      next = addPlainDays(cursor, step);
      key = plainDateString(cursor);
    }
    const rawStart = zonedLocalToUtc(cursor.year, cursor.month, cursor.day, 0, timeZone, true);
    const rawEnd = zonedLocalToUtc(next.year, next.month, next.day, 0, timeZone, true);
    if (!rawStart || !rawEnd) {
      throw recurrenceError("unresolved", "Stored recurrence dates could not be resolved.");
    }
    const startsAt = rawStart > windowStart ? rawStart : windowStart;
    const endsAt = rawEnd < windowEnd ? rawEnd : windowEnd;
    if (startsAt < endsAt) {
      out.push({ key, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });
    }
    cursor = next;
  }
  return out;
}

/**
 * ``$group`` key expression that lands each row in its local bucket, or null
 * for a "once" requirement (one group). ``dateExpression`` is the instant a
 * row is bucketed by: coaching uses the game's start, goals its end
 * (``"$date"``, the analyzer's own date filter field).
 *
 * @param {Pick<RecurrenceRequirement, "recurrence" | "timeZone">} requirement
 * @param {unknown} dateExpression
 * @returns {Record<string, any> | null}
 */
function recurrenceGroupExpression(requirement, dateExpression) {
  if (requirement.recurrence === "once") return null;
  const unit = requirement.recurrence === "daily"
    ? "day" : requirement.recurrence === "weekly" ? "week" : "month";
  return {
    $dateTrunc: {
      date: dateExpression,
      unit,
      timezone: canonicalTimeZone(requirement.timeZone) || "UTC",
      ...(unit === "week" ? { startOfWeek: "monday" } : {}),
    },
  };
}

/**
 * The bucket key of a ``recurrenceGroupExpression`` group id (a truncated
 * local-midnight instant), matching ``recurrenceBuckets`` keys. Null for an
 * unusable id.
 *
 * Example: monthly in Europe/London, id 2026-03-01T00:00Z → "2026-03".
 *
 * @param {Pick<RecurrenceRequirement, "recurrence" | "timeZone">} requirement
 * @param {unknown} groupId
 * @returns {string | null}
 */
function bucketKeyFor(requirement, groupId) {
  if (requirement.recurrence === "once") return "once";
  const date = toDate(groupId);
  if (date.getTime() <= 0) return null;
  const parts = zonedParts(date, canonicalTimeZone(requirement.timeZone) || "UTC");
  const local = plainDateString(parts);
  return requirement.recurrence === "monthly" ? local.slice(0, 7) : local;
}

module.exports = {
  RECURRENCES,
  canonicalTimeZone,
  zonedParts,
  zonedLocalToUtc,
  parsePlainDate,
  plainDateSerial,
  addPlainDays,
  plainDateString,
  localWindow,
  recurrenceBuckets,
  recurrenceGroupExpression,
  bucketKeyFor,
};
