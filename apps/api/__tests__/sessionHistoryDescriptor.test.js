"use strict";

const { encode, digest, parseSessionDescriptor, parsePageDescriptor, parseGamePageDescriptor } = require("../src/services/sessionHistoryDescriptor");
const { localDayWindow, naturalSpan, membershipFilters } = require("../src/services/sessionHistoryWindow");
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-27T12:00:00.000Z");
/** @param {Partial<import('../src/services/sessionHistoryTypes').SessionDescriptor>} [extra] */
function locator(extra = {}) {
  return { v: /** @type {const} */ (1), k: /** @type {const} */ ("natural"), s: digest(["owner", "scope"]), g: 90, a: null,
    f: "2026-10-25T12:00:00.000Z", e: "2026-10-25T13:00:00.000Z", h: digest(["content"]), ...extra };
}

test("natural locators retain bounded canonical scalar identity, with no auth capability", () => {
  const value = locator();
  expect(parseSessionDescriptor(encode(value))).toEqual(value);
  expect(() => parseSessionDescriptor(encode({ ...value, owner: "foreign" }))).toThrow("session_history_request_invalid");
  expect(() => parseSessionDescriptor(encode({ ...value, g: { $gt: 0 } }))).toThrow();
  expect(() => parseSessionDescriptor(encode({ ...value, a: value.f }))).toThrow();
  expect(() => parseSessionDescriptor(`${encode(value)}=`)).toThrow();
  expect(() => parseSessionDescriptor("x".repeat(2049))).toThrow();
});

test("noncanonical key order and reversed supported instants fail strictly", () => {
  const value = locator();
  const { k, ...rest } = value;
  expect(() => parseSessionDescriptor(encode({ k, ...rest }))).toThrow();
  expect(() => parseSessionDescriptor(encode(locator({ f: "+010000-01-01T00:00:00.000Z", e: "2026-10-25T13:00:00.000Z" })))).toThrow();
  const ancient = locator({ f: "-000001-01-01T00:00:00.000Z", e: "0001-01-01T00:00:00.000Z" });
  expect(parseSessionDescriptor(encode(ancient))).toEqual(ancient);
});

test("continuations bind a frozen complete window and exact session locator", () => {
  const value = { v: 1, k: "before", s: digest(["owner", "scope"]), g: 90,
    f: "2026-10-01T00:00:00.000Z", t: "2026-10-27T00:00:00.000Z", n: "2026-10-27T12:00:00.000Z", c: 0, z: "UTC", h: digest(["window"]), b: encode(locator()) };
  expect(parsePageDescriptor(encode(value))).toEqual(value);
  expect(() => parsePageDescriptor(encode({ ...value, c: 31 }))).toThrow();
  expect(() => parsePageDescriptor(encode({ ...value, t: value.f }))).toThrow();
  const games = { v: 1, k: "games", s: encode(locator()), p: 50 };
  expect(parseGamePageDescriptor(encode(games))).toEqual(games);
  expect(() => parseGamePageDescriptor(encode({ ...games, p: 0 }))).toThrow();
});

test.each([["2026-03-08", 23], ["2026-11-01", 25]])("local day %s uses its DST interval", (day, hours) => {
  const span = localDayWindow(day, "America/New_York");
  expect((span.to - span.from) / 3_600_000).toBe(hours);
});

test("selected membership dates remain separate from a day output and finite context", () => {
  const filters = { since: new Date("2026-09-01T00:00:00.000Z"), until: new Date("2026-10-31T23:59:59.999Z") };
  const span = naturalSpan({ day: "2026-10-25", tz: "America/New_York", contextDays: "1" }, NOW, 90, filters);
  expect(span.from).toBe(Date.parse("2026-10-25T04:00:00.000Z"));
  expect(span.scanFrom).toBe(span.from - DAY);
  expect(filters.since.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  expect(() => naturalSpan({ windowFrom: "2026-08-01T00:00:00.000Z", windowTo: "2026-10-25T00:00:00.000Z" }, NOW, 90, {})).toThrow();
  expect(() => naturalSpan({ contextDays: "1e3" }, NOW, 90, {})).toThrow();
  expect(() => localDayWindow("2026-02-30", "UTC")).toThrow();
});


test("membership dates preserve existing date-only transport while rejecting malformed widening", () => {
  expect(membershipFilters({ since: "2026-10-01", until: "2026-10-25" })).toEqual({ since: new Date("2026-10-01"), until: new Date("2026-10-25") });
  expect(() => membershipFilters({ since: "not-a-date" })).toThrow("session_history_request_invalid");
});
