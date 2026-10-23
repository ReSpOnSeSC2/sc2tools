// @ts-nocheck
"use strict";

/**
 * Pure-compute coverage for ``services/scouting/opponentTendencies``:
 * the favourite opening, predicted strategies and cheese alert the
 * overlay derives from the streamer's own games against one opponent.
 * The Mongo-backed wiring lives in
 * ``overlayLive.opponentTendencies.test.js``.
 */

const {
  MIN_TENDENCY_GAMES,
  CHEESE_ALERT_THRESHOLD,
  cheeseProbability,
  personalOppStrategy,
  summarizeOpponentTendencies,
  tendenciesFromLegacyOpenings,
  hasTendencies,
} = require("../src/services/scouting/opponentTendencies");
const Dna = require("../src/services/dnaTimings");

/** Newest-first rows carrying only a stored strategy (no ``opening``). */
function rows(...strategies) {
  return strategies.map((strategy) => ({
    durationSec: 600,
    opponent: { race: "Zerg", strategy },
  }));
}

/** A row whose opponent build the streamer corrected at check-in. */
function corrected(stored, detected) {
  return {
    durationSec: 600,
    opponent: { race: "Zerg", strategy: stored },
    buildIntent: {
      opponent: {
        status: "confirmed",
        applied: true,
        build: { source: "catalog", key: "x", name: stored },
        detected: { name: detected, slug: null },
      },
    },
  };
}

test("keyword classifier keeps its 0.7 / 0.1 split around the 0.4 alert", () => {
  expect(CHEESE_ALERT_THRESHOLD).toBe(0.4);
  expect(cheeseProbability("Zerg - 12 Pool")).toBe(0.7);
  expect(cheeseProbability("Proxy 2 Gate")).toBe(0.7);
  expect(cheeseProbability("Zerg - Hatch First")).toBe(0.1);
  expect(cheeseProbability(null)).toBe(0.1);
});

test("derives every field from stored strategies alone (rows without `opening`)", () => {
  const t = summarizeOpponentTendencies(
    rows("Zerg - 12 Pool", "Zerg - Hatch First", "Zerg - 12 Pool"),
  );
  expect(t.window).toBe(3);
  expect(t.favOpening).toEqual({
    name: "Zerg - 12 Pool",
    share: 2 / 3,
    samples: 2,
    of: 3,
  });
  expect(t.predictedStrategies.map((p) => p.name)).toEqual([
    "Zerg - 12 Pool",
    "Zerg - Hatch First",
  ]);
  expect(t.cheeseProbability).toBeCloseTo(2 / 3);
  expect(t.cheeseHistory).toEqual({ samples: 2, of: 3 });
});

test("predictions are the dossier's recency-weighted numbers for the same games", () => {
  const strategies = Array.from({ length: 14 }, (_, i) =>
    (i < 4 ? "Zerg - Roach Rush" : "Zerg - Hatch First"));
  const t = summarizeOpponentTendencies(rows(...strategies));
  const dossier = Dna.recencyWeightedStrategies(rows(...strategies));
  expect(t.predictedStrategies).toEqual(
    dossier.map((p) => ({ name: p.strategy, weight: p.probability })),
  );
});

test("a check-in correction counts under the build the streamer chose", () => {
  const row = corrected("Zerg - 12 Pool", "Zerg - Hatch First");
  expect(personalOppStrategy(row)).toBe("Zerg - 12 Pool");
  // Stored label lost (partial write): the confirmed build still wins.
  const stale = { ...row, opponent: { race: "Zerg", strategy: "Zerg - Hatch First" } };
  expect(personalOppStrategy(stale)).toBe("Zerg - 12 Pool");

  const t = summarizeOpponentTendencies([
    corrected("Zerg - 12 Pool", "Zerg - Hatch First"),
    ...rows("Zerg - 12 Pool", "Zerg - Hatch First"),
  ]);
  expect(t.favOpening).toMatchObject({ name: "Zerg - 12 Pool", samples: 2, of: 3 });
});

test("an unapplied correction leaves the stored label in charge", () => {
  const row = corrected("Zerg - Hatch First", "Zerg - Hatch First");
  row.buildIntent.opponent.applied = false;
  row.buildIntent.opponent.build.name = "Zerg - 12 Pool";
  expect(personalOppStrategy(row)).toBe("Zerg - Hatch First");
});

test("cheese shows at 40% and hides just below it", () => {
  // Equal recency weights inside the last 10: 2 of 5 = 0.4 exactly.
  const atThreshold = summarizeOpponentTendencies(rows(
    "Zerg - 12 Pool", "Zerg - Hatch First", "Zerg - Hatch First",
    "Zerg - 12 Pool", "Zerg - Hatch First",
  ));
  expect(atThreshold.cheeseProbability).toBeCloseTo(0.4);
  expect(atThreshold.cheeseHistory).toEqual({ samples: 2, of: 5 });

  const below = summarizeOpponentTendencies(rows(
    "Zerg - 12 Pool", "Zerg - Hatch First", "Zerg - Hatch First",
  ));
  expect(below.cheeseProbability).toBeUndefined();
  expect(below.cheeseHistory).toBeUndefined();
});

test("cheese is recency-weighted: the last 10 games count double", () => {
  // Newest 10 are cheese (weight 2 each), 10 older macro games weight 1.
  const t = summarizeOpponentTendencies(rows(
    ...Array(10).fill("Zerg - 12 Pool"),
    ...Array(10).fill("Zerg - Hatch First"),
  ));
  expect(t.cheeseProbability).toBeCloseTo(20 / 30);
  expect(t.cheeseHistory).toEqual({ samples: 10, of: 20 });
});

test(`needs ${MIN_TENDENCY_GAMES} games, and an opening seen twice to call it a favourite`, () => {
  expect(summarizeOpponentTendencies(rows("Zerg - 12 Pool"))).toEqual({ window: 1 });
  expect(summarizeOpponentTendencies([])).toEqual({ window: 0 });

  const split = summarizeOpponentTendencies(rows("Zerg - 12 Pool", "Zerg - Hatch First"));
  expect(split.favOpening).toBeUndefined();
  expect(split.predictedStrategies).toHaveLength(2);
  expect(split.cheeseProbability).toBeCloseTo(0.5);
});

test("a tie for favourite goes to the opening seen most recently", () => {
  const t = summarizeOpponentTendencies(rows(
    "Zerg - Hatch First", "Zerg - Pool First", "Zerg - Pool First", "Zerg - Hatch First",
  ));
  expect(t.favOpening.name).toBe("Zerg - Hatch First");
});

test("unlabelled games stay in the window but never become a prediction", () => {
  const t = summarizeOpponentTendencies(rows("", "Zerg - Hatch First", null, "Zerg - Hatch First"));
  expect(t.window).toBe(4);
  expect(t.favOpening).toMatchObject({ samples: 2, of: 4, share: 0.5 });
  expect(t.predictedStrategies).toEqual([{ name: "Zerg - Hatch First", weight: 0.5 }]);
});

test("games under 45 seconds never count toward a tendency", () => {
  const t = summarizeOpponentTendencies([
    { durationSec: 20, opponent: { strategy: "Zerg - 12 Pool" } },
    { durationSec: 600, opponent: { strategy: "Zerg - Game Too Short" } },
    ...rows("Zerg - Hatch First", "Zerg - Hatch First"),
  ]);
  expect(t.window).toBe(2);
  expect(t.favOpening).toMatchObject({ name: "Zerg - Hatch First", samples: 2, of: 2 });
  expect(t.cheeseProbability).toBeUndefined();
});

test("legacy openings maps still read as plain frequencies", () => {
  const t = tendenciesFromLegacyOpenings({ "Pool first": 4, Macro: 1, "Roach All-in": 1 });
  expect(t.favOpening).toEqual({ name: "Pool first", share: 4 / 6, samples: 4, of: 6 });
  expect(t.predictedStrategies[0]).toEqual({ name: "Pool first", weight: 4 / 6 });
  expect(t.cheeseProbability).toBeCloseTo(5 / 6);
  expect(t.cheeseHistory).toEqual({ samples: 5, of: 6 });

  expect(tendenciesFromLegacyOpenings({ Macro: 3 }).cheeseProbability).toBeUndefined();
  expect(tendenciesFromLegacyOpenings({})).toBeNull();
  expect(tendenciesFromLegacyOpenings({ Bad: "x", Zero: 0 })).toBeNull();
  expect(tendenciesFromLegacyOpenings(null)).toBeNull();
});

test("hasTendencies only accepts summaries with something to show", () => {
  expect(hasTendencies({ window: 1 })).toBe(false);
  expect(hasTendencies({ window: 3 })).toBe(false);
  expect(hasTendencies(summarizeOpponentTendencies(rows("", "")))).toBe(false);
  expect(hasTendencies(summarizeOpponentTendencies(rows("A", "B")))).toBe(true);
  expect(hasTendencies(null)).toBe(false);
});
