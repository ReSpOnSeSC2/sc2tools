"use strict";

const Dna = require("../src/services/dnaTimings");

/** @param {number} seconds @param {string} result */
const game = (seconds, result) => ({ gameId: `${seconds}-${result}`, date: new Date("2026-10-01"), result,
  myRace: "Protoss", opponent: { race: "Zerg" }, buildLog: [`[${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}] Gateway`] });

test("actual stored and legacy outcome spellings share the same measured sample with draws kept separate", () => {
  const games = ["Victory", "victory", "Win", "win", "WIN"].map((result, index) => game(100 + index * 10, result))
    .concat(["Defeat", "defeat", "Loss", "loss", "LOSS"].map((result, index) => game(200 + index * 10, result)),
      [game(999, "Tie"), game(1000, "Undecided")]);
  const timing = Dna.computeMedianTimingsForMatchup(games, "P", "Z").Gateway;
  expect(timing).toMatchObject({ sampleCount: 12, winnerSampleCount: 5, loserSampleCount: 5,
    winnerMedianSeconds: 120, loserMedianSeconds: 220 });
  expect(timing.samples).toHaveLength(12);
  expect(timing.winRateWhenBuilt).toBeCloseTo(5 / 12);
});

test("both outcome medians stay absent if either measured side has fewer than five", () => {
  const games = Array.from({ length: 5 }, (_, i) => game(100 + i, "Victory"))
    .concat(Array.from({ length: 4 }, (_, i) => game(200 + i, "Defeat")), [game(300, "Tie")]);
  expect(Dna.computeMedianTimingsForMatchup(games, "P", "Z").Gateway).toMatchObject({ winnerSampleCount: 5,
    loserSampleCount: 4, winnerMedianSeconds: null, loserMedianSeconds: null });
});

test("unobserved tokens and invalid timing numbers never invent an outcome comparison", () => {
  expect(Dna.emptyTokenRow({ internalName: "Gateway", displayName: "Gateway", iconFile: "gateway.png", token: "Gateway", tier: 1, category: "production" }, "build_log"))
    .toMatchObject({ winnerMedianSeconds: null, loserMedianSeconds: null, winnerSampleCount: 0, loserSampleCount: 0 });
  const samples = Array.from({ length: 5 }, (_, seconds) => ({ seconds, result: "Victory" }))
    .concat(Array.from({ length: 4 }, (_, seconds) => ({ seconds, result: "Defeat" })),
      [Infinity, NaN, -1].map(seconds => ({ seconds, result: "Defeat" })));
  expect(Dna.timingOutcomeMedians(/** @type {any} */ (samples))).toMatchObject({ winnerSampleCount: 5,
    loserSampleCount: 4, winnerMedianSeconds: null, loserMedianSeconds: null });
});

test("Mongo Date samples sort chronologically rather than by weekday text", () => {
  const games = Array.from({ length: 6 }, (_, index) => ({ ...game(index < 3 ? 100 : 200, "Victory"), date: new Date(Date.UTC(2026, 9, 5 + index)) }));
  const timing = Dna.computeMedianTimingsForMatchup(games, "P", "Z").Gateway;
  expect(timing).toMatchObject({ trend: "later", lastSeenSeconds: 200 });
  expect(timing.samples[0].date).toEqual(new Date(Date.UTC(2026, 9, 10)));
});

test("invalid dates retain measured quantiles but suppress recency claims", () => {
  const games = Array.from({ length: 6 }, (_, index) => ({ ...game(100 + index, "Victory"), date: new Date(NaN) }));
  expect(Dna.computeMedianTimingsForMatchup(games, "P", "Z").Gateway).toMatchObject({ sampleCount: 6,
    medianSeconds: 102.5, trend: "unknown", lastSeenSeconds: null });
});
