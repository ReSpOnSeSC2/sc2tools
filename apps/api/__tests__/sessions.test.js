"use strict";
/** @typedef {Record<string,unknown> & {fixture:string,date?:unknown}} FixtureGame */
/** @type {Array<{name:string,gapMinutes:number,tz?:string,games:FixtureGame[],groups:string[][]}>} */
const fixtures = require("../../../shared/fixtures/sessions.json");
const { sessionize, ordered, instant, outcome, codePoints } = require("../src/services/sessions");

test.each(fixtures)("shared session fixture: $name", fixture => {
  const before = structuredClone(fixture.games);
  const groups = sessionize(fixture.games, fixture);
  expect(groups.map(group => group.games.map(game => game.fixture))).toEqual(fixture.groups);
  expect(fixture.games).toEqual(before);
  for (const group of groups) for (const game of group.games) expect(fixture.games).toContain(game);
});

test.each([15, 90, 240, 480])("gap%d uses strict boundary and keeps equality", gapMinutes => {
  /** @param {number} date */
  const game = date => ({ date, gameId: "a", result: "Victory" });
  for (const delta of [-1, 0, 1]) expect(sessionize([game(0), game(gapMinutes * 60000 + delta)], { gapMinutes })).toHaveLength(delta > 0 ? 2 : 1);
});

test("normalizes only supported instants without guessing seconds or local dates", () => {
  expect(instant(new Date(0))).toBe(0); expect(instant(0.9)).toBe(0);
  expect(instant("1970-01-01T01:00:00+01:00")).toBe(0);
  for (const value of [null, false, "", "1970-01-01", "invalid", Infinity, 8640000000000001]) expect(instant(value)).toBeNull();
  expect(instant(8640000000000000)).toBe(8640000000000000);
});

test("typed fallback distinguishes missing/null/boolean/zero and never deduplicates", () => {
  const rows = [{ date: 0, myMmr: 0 }, { date: 0, myMmr: null }, { date: 0 }, { date: 0, myMmr: false }];
  expect(ordered(rows).map(row => row.game)).toEqual([rows[2], rows[1], rows[3], rows[0]]);
  expect(sessionize([rows[0], rows[0]], { gapMinutes: 90 })[0].games).toHaveLength(2);
});

test("case aliases do not trim unknown results; NUL and supplementary comparisons stay opaque", () => {
  expect(["win", "Victory", "loss", "DEFEAT", " win "].map(outcome)).toEqual(["W", "W", "L", "L", "U"]);
  expect(codePoints("a\0b", "a\0c")).toBeLessThan(0);
  expect(codePoints("\ue000", "\u{1f600}")).toBeLessThan(0);
});
