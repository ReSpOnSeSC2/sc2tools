"use strict";

// Bingo objective resolver tests. Uses the in-memory predicate
// registry rather than the full Mongo path; the resolveQuests method
// is exercised in routes/arcade.test.js.

const { PREDICATES } = require("../../src/services/arcade");

const w = (over = {}) => ({
  gameId: "x",
  result: "Win",
  date: new Date().toISOString(),
  ...over,
});
const l = (over = {}) => w({ result: "Loss", ...over });

describe("Bingo PREDICATES", () => {
  test("any_game ticks on the first game", () => {
    expect(PREDICATES.any_game([w({ gameId: "g1" })])).toBe("g1");
    expect(PREDICATES.any_game([])).toBe(null);
  });

  test("any_win ignores losses", () => {
    expect(
      PREDICATES.any_win([l({ gameId: "1" }), w({ gameId: "2" })]),
    ).toBe("2");
  });

  test("win_on_map matches case-insensitively", () => {
    const games = [w({ gameId: "g", map: "Equilibrium" })];
    expect(PREDICATES.win_on_map(games, { map: "equilibrium" })).toBe("g");
    expect(PREDICATES.win_on_map(games, { map: "Frostline" })).toBe(null);
  });

  test("win_as_race + win_vs_race compare on the first letter", () => {
    expect(
      PREDICATES.win_as_race([w({ gameId: "g", myRace: "Protoss" })], { race: "P" }),
    ).toBe("g");
    expect(
      PREDICATES.win_vs_race([w({ gameId: "g", oppRace: "Zerg" })], { race: "Z" }),
    ).toBe("g");
  });

  test("win_vs_higher_mmr requires a positive diff", () => {
    expect(
      PREDICATES.win_vs_higher_mmr(
        [w({ gameId: "g", myMmr: 4000, opponent: { mmr: 4150 } })],
        { diff: 100 },
      ),
    ).toBe("g");
    expect(
      PREDICATES.win_vs_higher_mmr(
        [w({ gameId: "g", myMmr: 4000, opponent: { mmr: 4050 } })],
        { diff: 100 },
      ),
    ).toBe(null);
  });

  test("three_in_a_row_win finds the 3rd consecutive win", () => {
    expect(
      PREDICATES.three_in_a_row_win([
        l({ gameId: "1" }),
        w({ gameId: "2" }),
        w({ gameId: "3" }),
        w({ gameId: "4" }),
      ]),
    ).toBe("4");
  });

  test("win_under_seconds + win_over_seconds gate by duration", () => {
    expect(
      PREDICATES.win_under_seconds([w({ gameId: "g", duration: 240 })], { maxSec: 360 }),
    ).toBe("g");
    expect(
      PREDICATES.win_over_seconds([w({ gameId: "g", duration: 1800 })], { minSec: 1500 }),
    ).toBe("g");
  });

  test("macro_above gates on macro_score", () => {
    expect(
      PREDICATES.macro_above([w({ gameId: "g", macro_score: 80 })], { minScore: 70 }),
    ).toBe("g");
    expect(
      PREDICATES.macro_above([w({ gameId: "g", macro_score: 60 })], { minScore: 70 }),
    ).toBe(null);
  });
});
