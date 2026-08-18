// @ts-nocheck
"use strict";

const {
  parseFilters,
  parseDate,
  parseFiniteInt,
  parseBool,
  clampInt,
  parseRaceLetter,
  caseInsensitiveContains,
  gamesMatchStage,
  resultBucket,
  MAX_GAME_LENGTH_MINUTES,
} = require("../src/util/parseQuery");
const { DURATION_BUCKETS } = require("../src/services/macroReport");

describe("util/parseQuery", () => {
  describe("parseFilters", () => {
    test("returns empty object for missing input", () => {
      expect(parseFilters(undefined)).toEqual({});
      expect(parseFilters(null)).toEqual({});
      expect(parseFilters({})).toEqual({});
    });

    test("parses dates, races, map, mmr, opp_strategy", () => {
      const out = parseFilters({
        since: "2026-04-01",
        until: "2026-04-30",
        race: "Z",
        opp_race: "Protoss",
        map: "Goldenaura",
        mmr_min: "3500",
        mmr_max: "5000",
        opp_strategy: "Cheese",
      });
      expect(out.since instanceof Date).toBe(true);
      expect(out.until instanceof Date).toBe(true);
      expect(out.race).toBe("Z");
      expect(out.oppRace).toBe("P");
      expect(out.map).toBe("goldenaura");
      expect(out.mmrMin).toBe(3500);
      expect(out.mmrMax).toBe(5000);
      expect(out.oppStrategy).toBe("Cheese");
    });

    test("parses group_by_race_played truthy", () => {
      expect(parseFilters({ group_by_race_played: "true" }).groupByRacePlayed).toBe(true);
      expect(parseFilters({ group_by_race_played: "1" }).groupByRacePlayed).toBe(true);
      expect(parseFilters({ group_by_race_played: "no" }).groupByRacePlayed).toBeUndefined();
    });

    test("drops invalid race letters", () => {
      expect(parseFilters({ race: "X" }).race).toBeUndefined();
    });

    test("drops invalid mmr", () => {
      expect(parseFilters({ mmr_min: "abc" }).mmrMin).toBeUndefined();
    });
  });

  describe("parseDate / parseFiniteInt / parseBool / clampInt", () => {
    test("parseDate accepts ISO and space-separated formats", () => {
      expect(parseDate("2026-04-15")?.toISOString()).toContain("2026-04-15");
      expect(parseDate("2026-04-15 12:34")?.toISOString()).toContain("2026-04-15");
      expect(parseDate("not-a-date")).toBeNull();
      expect(parseDate(null)).toBeNull();
    });

    test("parseFiniteInt clamps non-numerics", () => {
      expect(parseFiniteInt(7)).toBe(7);
      expect(parseFiniteInt("9")).toBe(9);
      expect(parseFiniteInt("abc")).toBeUndefined();
      expect(parseFiniteInt(undefined)).toBeUndefined();
    });

    test("parseBool handles common truthy strings", () => {
      expect(parseBool(true)).toBe(true);
      expect(parseBool("yes")).toBe(true);
      expect(parseBool("1")).toBe(true);
      expect(parseBool("False")).toBe(false);
    });

    test("clampInt enforces fallback and max", () => {
      expect(clampInt("abc", 5)).toBe(5);
      expect(clampInt(0, 5)).toBe(5);
      expect(clampInt(50, 5, 25)).toBe(25);
      expect(clampInt(10, 5, 25)).toBe(10);
    });
  });

  describe("parseRaceLetter / caseInsensitiveContains", () => {
    test("parseRaceLetter returns canonical letter or null", () => {
      expect(parseRaceLetter("Protoss")).toBe("P");
      expect(parseRaceLetter("zerg")).toBe("Z");
      expect(parseRaceLetter("R")).toBe("R");
      expect(parseRaceLetter("X")).toBeNull();
      expect(parseRaceLetter(null)).toBeNull();
    });

    test("caseInsensitiveContains escapes regex specials", () => {
      const re = caseInsensitiveContains("a.b+c");
      expect(re.test("xa.b+cy")).toBe(true);
      expect(re.test("axxbxxc")).toBe(false);
    });
  });

  describe("gamesMatchStage", () => {
    test("seeds userId always", () => {
      const stage = gamesMatchStage("u1", {});
      expect(stage.userId).toBe("u1");
    });

    test("emits date range with $gte/$lte", () => {
      const since = new Date("2026-04-01");
      const until = new Date("2026-04-30");
      const stage = gamesMatchStage("u1", { since, until });
      expect(stage.date.$gte).toBe(since);
      expect(stage.date.$lte).toBe(until);
    });

    test("race letter becomes case-insensitive prefix regex", () => {
      const stage = gamesMatchStage("u1", { race: "Z", oppRace: "P" });
      expect(stage.myRace.test("Zerg")).toBe(true);
      expect(stage.myRace.test("Protoss")).toBe(false);
      expect(stage["opponent.race"].test("Protoss")).toBe(true);
    });

    test("map becomes a case-insensitive contains regex", () => {
      const stage = gamesMatchStage("u1", { map: "golden" });
      expect(stage.map.test("Goldenaura")).toBe(true);
      expect(stage.map.test("Acropolis")).toBe(false);
    });

    test("mmr filters become bounded $gte/$lte", () => {
      const stage = gamesMatchStage("u1", { mmrMin: 3000, mmrMax: 5000 });
      expect(stage["opponent.mmr"]).toEqual({ $gte: 3000, $lte: 5000 });
    });

    test("opp_strategy and build pass-through", () => {
      const stage = gamesMatchStage("u1", { oppStrategy: "Cheese", build: "P - Stargate" });
      expect(stage["opponent.strategy"]).toBe("Cheese");
      expect(stage.myBuild).toBe("P - Stargate");
    });

    test("excludeTooShort flips a Mongo $not regex on myBuild + opponent.strategy", () => {
      const stage = gamesMatchStage("u1", { excludeTooShort: true });
      expect(stage.myBuild).toEqual({ $not: /Game Too Short$/ });
      expect(stage["opponent.strategy"]).toEqual({ $not: /Game Too Short$/ });
    });

    test("excludeTooShort defers to an explicit build / opp_strategy filter", () => {
      // The user picked a specific build; the explicit filter wins
      // and the regex isn't applied to myBuild. opponent.strategy
      // still gets the regex because the user didn't filter it.
      const stage = gamesMatchStage("u1", {
        excludeTooShort: true,
        build: "Terran - Cyclone Rush",
      });
      expect(stage.myBuild).toBe("Terran - Cyclone Rush");
      expect(stage["opponent.strategy"]).toEqual({ $not: /Game Too Short$/ });
    });

    test("regions filter emits a two-tier $or (stored region OR toonHandle prefix)", () => {
      const stage = gamesMatchStage("u1", { regions: ["NA", "EU"] });
      expect(Array.isArray(stage.$or)).toBe(true);
      expect(stage.$or).toHaveLength(3);
      expect(stage.$or[0]).toEqual({ "opponent.region": { $in: ["NA", "EU"] } });
      // Two fall-through clauses cover rows that pre-date the stored
      // ``opponent.region`` field — match by toon_handle leading byte.
      const [, bNullEmpty, bMissing] = stage.$or;
      expect(bNullEmpty["opponent.toonHandle"].$regex).toBe("^(1|2)-");
      expect(bMissing["opponent.toonHandle"].$regex).toBe("^(1|2)-");
    });

    test("parseFilters surfaces exclude_too_short=1 as excludeTooShort:true", () => {
      const out = parseFilters({ exclude_too_short: "1" });
      expect(out.excludeTooShort).toBe(true);
      expect(parseFilters({ exclude_too_short: "true" }).excludeTooShort).toBe(true);
      expect(parseFilters({ exclude_too_short: "on" }).excludeTooShort).toBe(true);
      expect(parseFilters({ exclude_too_short: "0" }).excludeTooShort).toBeUndefined();
      expect(parseFilters({}).excludeTooShort).toBeUndefined();
    });

    test("mapPool ladder/nonladder match authoritative isLadderGame", () => {
      expect(gamesMatchStage("u1", { mapPool: "ladder" }).$and).toEqual([
        { isLadderGame: true },
      ]);
      expect(gamesMatchStage("u1", { mapPool: "nonladder" }).$and).toEqual([
        { isLadderGame: false },
      ]);
      expect(gamesMatchStage("u1", {}).$and).toBeUndefined();
    });

    test("gameSize prefers matchFormat and keeps only a safe 1v1 legacy fallback", () => {
      expect(gamesMatchStage("u1", { gameSize: "1v1" }).$and).toEqual([
        {
          $or: [
            { matchFormat: "1v1" },
            { matchFormat: { $exists: false }, playerCount: 2 },
          ],
        },
      ]);
      expect(gamesMatchStage("u1", { gameSize: "team" }).$and).toEqual([
        { matchFormat: "team" },
      ]);
      expect(gamesMatchStage("u1", {}).$and).toBeUndefined();
    });

    test("ranked/custom and format clauses coexist with the region $or", () => {
      const stage = gamesMatchStage("u1", {
        regions: ["NA"],
        mapPool: "ladder",
        gameSize: "1v1",
      });
      expect(stage.$or).toHaveLength(3);
      expect(stage.$and).toEqual([
        { isLadderGame: true },
        {
          $or: [
            { matchFormat: "1v1" },
            { matchFormat: { $exists: false }, playerCount: 2 },
          ],
        },
      ]);
    });

    test("parseFilters accepts map_pool and game_size enums, drops junk", () => {
      expect(parseFilters({ map_pool: "ladder" }).mapPool).toBe("ladder");
      expect(parseFilters({ map_pool: "nonladder" }).mapPool).toBe("nonladder");
      expect(parseFilters({ map_pool: "all" }).mapPool).toBeUndefined();
      expect(parseFilters({ map_pool: "bogus" }).mapPool).toBeUndefined();
      expect(parseFilters({ game_size: "1v1" }).gameSize).toBe("1v1");
      expect(parseFilters({ game_size: "team" }).gameSize).toBe("team");
      expect(parseFilters({ game_size: "all" }).gameSize).toBeUndefined();
      expect(parseFilters({ game_size: "2v2" }).gameSize).toBeUndefined();
    });

    test("regions filter parses CSV, drops unknown labels, dedupes", () => {
      expect(parseFilters({ regions: "NA,EU" }).regions).toEqual(["NA", "EU"]);
      expect(parseFilters({ regions: "na, eu, kr" }).regions).toEqual([
        "NA",
        "EU",
        "KR",
      ]);
      expect(parseFilters({ regions: "NA,XX,EU,NA" }).regions).toEqual([
        "NA",
        "EU",
      ]);
      expect(parseFilters({ regions: "" }).regions).toBeUndefined();
      expect(parseFilters({ regions: "XX,YY" }).regions).toBeUndefined();
      expect(parseFilters({}).regions).toBeUndefined();
    });
  });

  // The global "Game length" filter. Its whole reason for existing on
  // ``durationSec`` rather than any of the other time fields floating
  // around this codebase is that ``durationSec`` is real elapsed
  // seconds — the same source the Macro Report's game-length buckets
  // use. The last test in this block is the one that keeps that true.
  describe("game length filter", () => {
    test("parses whole-minute bounds off the query string", () => {
      expect(parseFilters({ min_minutes: "10", max_minutes: "20" })).toMatchObject({
        minMinutes: 10,
        maxMinutes: 20,
      });
    });

    test("either bound stands alone", () => {
      expect(parseFilters({ min_minutes: "20" })).toEqual({ minMinutes: 20 });
      expect(parseFilters({ max_minutes: "10" })).toEqual({ maxMinutes: 10 });
    });

    test.each([
      ["absent", {}],
      ["empty strings", { min_minutes: "", max_minutes: "" }],
      ["non-numeric", { min_minutes: "ten", max_minutes: "soon" }],
      ["negative", { min_minutes: "-5", max_minutes: "-1" }],
      // Zero is the absence of a lower bound, not a bound of its own —
      // emitting ``$gte: 0`` would silently drop every row with no
      // recorded duration for no user-visible reason.
      ["zero", { min_minutes: "0", max_minutes: "0" }],
    ])("drops %s bounds entirely", (_label, query) => {
      const out = parseFilters(query);
      expect(out.minMinutes).toBeUndefined();
      expect(out.maxMinutes).toBeUndefined();
    });

    test("clamps an absurd bound instead of passing it through", () => {
      expect(parseFilters({ max_minutes: "999999" }).maxMinutes).toBe(
        MAX_GAME_LENGTH_MINUTES,
      );
    });

    test("swaps a transposed pair rather than matching nothing", () => {
      // Taken literally this asks for games both under 5 and over 30
      // minutes, i.e. nothing. A blank dashboard is a worse answer to
      // an obvious typo than the range that was plainly meant.
      expect(parseFilters({ min_minutes: "30", max_minutes: "5" })).toMatchObject({
        minMinutes: 5,
        maxMinutes: 30,
      });
    });

    test("becomes an inclusive-min / exclusive-max range on durationSec", () => {
      const stage = gamesMatchStage("u1", { minMinutes: 10, maxMinutes: 20 });
      expect(stage.durationSec).toEqual({ $gte: 600, $lt: 1200 });
    });

    test("either bound alone leaves the other side open", () => {
      expect(gamesMatchStage("u1", { minMinutes: 20 }).durationSec).toEqual({
        $gte: 1200,
      });
      expect(gamesMatchStage("u1", { maxMinutes: 6 }).durationSec).toEqual({
        $lt: 360,
      });
    });

    test("no bounds leaves durationSec unconstrained", () => {
      expect(gamesMatchStage("u1", {})).not.toHaveProperty("durationSec");
    });

    test("composes with, and does not disturb, exclude_too_short", () => {
      // Regression guard: the 'Game Too Short' filter is a label match
      // on a different pair of fields and must keep working untouched
      // alongside a duration range.
      const stage = gamesMatchStage("u1", {
        minMinutes: 10,
        excludeTooShort: true,
      });
      expect(stage.durationSec).toEqual({ $gte: 600 });
      expect(stage.myBuild).toEqual({ $not: /Game Too Short$/ });
      expect(stage["opponent.strategy"]).toEqual({ $not: /Game Too Short$/ });
    });

    test("bounds line up exactly with the Macro Report's length buckets", () => {
      // The contract that makes clicking a "10–14 min" bar list the
      // games that bar counted: same field, same unit, same
      // inclusive-lower / exclusive-upper edges. If DURATION_BUCKETS
      // ever moves off durationSec or changes its tiling, this fails.
      for (const bucket of DURATION_BUCKETS) {
        const stage = gamesMatchStage("u1", {
          minMinutes: bucket.min === null ? undefined : bucket.min / 60,
          maxMinutes: bucket.max === null ? undefined : bucket.max / 60,
        });
        const expected = {};
        if (bucket.min !== null) expected.$gte = bucket.min;
        if (bucket.max !== null) expected.$lt = bucket.max;
        expect(stage.durationSec).toEqual(expected);
      }
    });
  });

  describe("resultBucket", () => {
    test.each([
      ["Victory", "win"],
      ["win", "win"],
      ["DEFEAT", "loss"],
      ["loss", "loss"],
      ["Tie", null],
      ["", null],
      [null, null],
    ])("buckets %p as %p", (input, expected) => {
      expect(resultBucket(input)).toBe(expected);
    });
  });
});
