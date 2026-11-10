"use strict";

/**
 * Calendar math for reports: ISO weeks of a user's local calendar.
 *
 * A week key is ``YYYY-Www`` (ISO 8601). Its bounds are local Monday 00:00
 * to the next local Monday 00:00 in the given IANA zone, converted to UTC
 * instants with a two-pass offset lookup so weeks that cross a DST change
 * are 167 or 169 hours long, exactly as the wall clock says.
 */

const DAY = 24 * 60 * 60 * 1000;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;
/** @type {Map<string, Intl.DateTimeFormat>} */
const FORMATTERS = new Map();

/** @param {unknown} value @returns {string|null} canonical IANA zone */
function canonicalTimeZone(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) return null;
  try { return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone; } catch { return null; }
}

/** @param {string} tz */
function formatter(tz) {
  let value = FORMATTERS.get(tz);
  if (!value) {
    if (FORMATTERS.size > 200) FORMATTERS.clear();
    value = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    FORMATTERS.set(tz, value);
  }
  return value;
}

/** Wall-clock fields of an instant in ``tz``; weekday 0 = Monday. @param {number} t @param {string} tz */
function localParts(t, tz) {
  /** @type {Record<string, number>} */
  const parts = {};
  for (const part of formatter(tz).formatToParts(new Date(t))) if (part.type !== "literal") parts[part.type] = Number(part.value);
  const weekday = (new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay() + 6) % 7;
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second, weekday };
}

/** Local wall time minus UTC, in ms. @param {number} t @param {string} tz */
function offsetMs(t, tz) {
  const p = localParts(t, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

/** UTC instant of a local wall time. @param {{y: number, m: number, d: number}} date @param {number} hour @param {string} tz */
function zonedInstant(date, hour, tz) {
  const guess = Date.UTC(date.y, date.m - 1, date.d, hour);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}

/** @param {{y: number, m: number, d: number}} date @param {number} days */
function addDays(date, days) {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d) + days * DAY);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** ISO week of a calendar date. @param {{y: number, m: number, d: number}} date */
function isoWeekOf(date) {
  const t = Date.UTC(date.y, date.m - 1, date.d);
  const thursday = t + (3 - ((new Date(t).getUTCDay() + 6) % 7)) * DAY;
  const year = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const firstThursday = jan4 + (3 - ((new Date(jan4).getUTCDay() + 6) % 7)) * DAY;
  return `${year}-W${String(1 + Math.round((thursday - firstThursday) / (7 * DAY))).padStart(2, "0")}`;
}

/** Monday of a week key, or null when the key is not a real ISO week. @param {unknown} key */
function mondayOf(key) {
  const match = typeof key === "string" ? WEEK_RE.exec(key) : null;
  if (!match) return null;
  const year = Number(match[1]); const week = Number(match[2]);
  if (year < 2000 || year > 2100 || week < 1 || week > 53) return null;
  const jan4 = Date.UTC(year, 0, 4);
  const monday1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  const t = new Date(monday1 + (week - 1) * 7 * DAY);
  const monday = { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  return isoWeekOf(monday) === key ? monday : null;
}

/** @param {string} key @param {string} tz */
function weekBounds(key, tz) {
  const monday = mondayOf(key);
  if (!monday) return null;
  return { start: new Date(zonedInstant(monday, 0, tz)), end: new Date(zonedInstant(addDays(monday, 7), 0, tz)) };
}

/** @param {string} key @param {number} weeks */
function shiftWeek(key, weeks) {
  const monday = mondayOf(key);
  return monday ? isoWeekOf(addDays(monday, weeks * 7)) : null;
}

/** @param {number} t @param {string} tz */
function weekKeyAt(t, tz) {
  const p = localParts(t, tz);
  return isoWeekOf({ y: p.year, m: p.month, d: p.day });
}

module.exports = { DAY, canonicalTimeZone, localParts, zonedInstant, isoWeekOf, mondayOf, weekBounds, shiftWeek, weekKeyAt, addDays };
