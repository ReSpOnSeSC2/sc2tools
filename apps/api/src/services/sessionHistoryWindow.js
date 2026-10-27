"use strict";

const { parseFilters, parseDate } = require("../util/parseQuery");
const { MAX_DATE_MS } = require("./sessions");
const { digest, integer, iso, invalid, stale } = require("./sessionHistoryDescriptor");
const DAY = 86_400_000;
const MAX_OUTPUT = 31 * DAY;
const MAX_ENVELOPE = 91 * DAY;

/** @param {unknown} value */
function timezone(value) {
  if (value === undefined) return "UTC";
  if (typeof value !== "string" || value.length > 100 || !value) return invalid();
  try { return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone; }
  catch { return invalid(); }
}
/** @param {Intl.DateTimeFormat} formatter @param {number} time */
function dayKey(formatter, time) {
  const parts = formatter.formatToParts(new Date(time));
  return ["year", "month", "day"].map(key => {
    const value = parts.find(part => part.type === key)?.value ?? "";
    return key === "year" ? value.padStart(4, "0") : value;
  }).join("-");
}
/** Binary lower bound on local calendar dates, not a fixed 24-hour day.
 * @param {Intl.DateTimeFormat} formatter @param {string} target @param {number} nominal */
function firstDayInstant(formatter, target, nominal) {
  let lo = nominal - 2 * DAY, hi = nominal + 2 * DAY;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (dayKey(formatter, mid) < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}
/** @param {unknown} value @param {string} tz */
function localDayWindow(value, tz) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid();
  const nominal = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 10) !== value) return invalid();
  const next = new Date(nominal + DAY).toISOString().slice(0, 10);
  const formatter = new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const from = firstDayInstant(formatter, value, nominal), to = firstDayInstant(formatter, next, nominal + DAY);
  if (dayKey(formatter, from) !== value || to <= from) return invalid();
  return { from, to };
}
/** @param {Record<string,unknown>} query */
function membershipFilters(query) {
  for (const key of ["since", "until"]) if (query[key] !== undefined && !parseDate(query[key])) return invalid();
  const filters = parseFilters(query);
  if (filters.since && filters.until && filters.since > filters.until) return invalid();
  return filters;
}
/** @param {Record<string,unknown>} query @param {number} asOf @param {string} tz @param {import('../util/parseQuery').GlobalFilters} filters */
function outputBounds(query, asOf, tz, filters) {
  if (query.day !== undefined) {
    if (query.windowFrom !== undefined || query.windowTo !== undefined) return invalid();
    const result = localDayWindow(query.day, tz);
    // A selected current local day extends to midnight, but future replay rows
    // are still excluded by the captured asOf in the scan envelope.
    return result;
  }
  if ((query.windowFrom === undefined) !== (query.windowTo === undefined)) return invalid();
  if (query.windowFrom !== undefined) return { from: Date.parse(iso(query.windowFrom)), to: Date.parse(iso(query.windowTo)) };
  const to = Math.min(asOf + 1, filters.until ? filters.until.getTime() + 1 : MAX_DATE_MS);
  return { from: Math.max(-MAX_DATE_MS, to - 30 * DAY), to };
}
/** @param {Record<string,unknown>} query @param {number} now @param {number} gap
 * @param {import('../util/parseQuery').GlobalFilters} filters @param {import('./sessionHistoryTypes').PageDescriptor|null} [page] */
function naturalSpan(query, now, gap, filters, page = null) {
  const tz = timezone(query.tz ?? page?.z), c = integer(query.contextDays ?? page?.c ?? 0, 0, 30);
  const asOf = page ? Date.parse(page.n) : now;
  if (asOf > now || !Number.isFinite(asOf)) return invalid();
  const bounds = page ? { from: Date.parse(page.f), to: Date.parse(page.t) } : outputBounds(query, asOf, tz, filters);
  if (page && (query.day !== undefined || query.windowFrom !== undefined || query.windowTo !== undefined)) {
    const requested = outputBounds(query, asOf, tz, filters);
    if (requested.from !== bounds.from || requested.to !== bounds.to) return stale();
  }
  if (bounds.to <= bounds.from || bounds.to - bounds.from > MAX_OUTPUT) return invalid();
  if (page && (tz !== page.z || c !== page.c)) return stale();
  return makeSpan(bounds.from, bounds.to, asOf, gap, c, tz, filters.since?.getTime() ?? null, filters.until?.getTime() ?? asOf);
}
/** @param {number} from @param {number} to @param {number} asOf @param {number} gap @param {number} c @param {string} tz @param {number|null} floor @param {number} ceiling
 * @returns {import('./sessionHistoryTypes').HistorySpan} */
function makeSpan(from, to, asOf, gap, c, tz, floor, ceiling) {
  const padding = Math.max(gap * 60_000, c * DAY);
  const scanFrom = Math.max(-MAX_DATE_MS, floor ?? -MAX_DATE_MS, from - padding);
  const scanTo = Math.min(MAX_DATE_MS, asOf, ceiling, to - 1 + padding);
  if (scanTo - scanFrom > MAX_ENVELOPE) return invalid();
  return { from, to, asOf, scanFrom, scanTo, contextDays: c, tz };
}
/** @param {string} owner @param {import('./sessionHistoryTypes').HistoryMode} mode @param {number} gap @param {object} filters */
function scopeHash(owner, mode, gap, filters) { return digest({ version: 1, owner, mode, gap, filters }); }
/** @param {import('./sessionHistoryTypes').HistorySpan} span */
function publicWindow(span) {
  return { from: new Date(span.from).toISOString(), to: new Date(span.to).toISOString(), asOf: new Date(span.asOf).toISOString(),
    scanFrom: new Date(span.scanFrom).toISOString(), scanTo: new Date(span.scanTo).toISOString(), contextDays: span.contextDays, tz: span.tz };
}
module.exports = { DAY, MAX_OUTPUT, MAX_ENVELOPE, timezone, localDayWindow, membershipFilters, naturalSpan, makeSpan, scopeHash, publicWindow };
