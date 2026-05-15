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
} = require("../src/util/parseQuery");

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
