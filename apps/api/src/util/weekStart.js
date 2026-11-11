"use strict";

/** Day names Mongo's $dateTrunc accepts for `startOfWeek`. */
const WEEK_DAYS = Object.freeze(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);

/**
 * The first day of a weekly bucket from a client query. Anything that is
 * not a full lowercase English day name falls back to Sunday (Mongo's own
 * default), so a malformed value never reaches the aggregation.
 *
 * Example: pickWeekStart("monday") // "monday"; pickWeekStart("Mon;drop") // "sunday"
 *
 * @param {unknown} raw
 * @returns {string}
 */
function pickWeekStart(raw) {
  return typeof raw === "string" && WEEK_DAYS.includes(raw) ? raw : "sunday";
}

module.exports = { WEEK_DAYS, pickWeekStart };
