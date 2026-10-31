// @ts-nocheck
"use strict";
// The corpus epoch is derived from the rules that decide what a corpus row holds and which games belong, so changing
// any of them moves CORPUS_EPOCH without anyone raising a constant. Each case loads the changes module in isolation
// with one rule changed.
const CHANGES = "../src/services/analysisCorpusChanges";
const GAMES = "../src/services/games";
const VISIBILITY = "../src/util/gameVisibility";

/** CORPUS_EPOCH as computed with `overrides` replacing exports of the named modules. */
function epochWith(overrides = {}) {
  let epoch;
  jest.isolateModules(() => {
    for (const [path, exports] of Object.entries(overrides)) {
      jest.doMock(path, () => ({ ...jest.requireActual(path), ...exports }));
    }
    epoch = require(CHANGES).CORPUS_EPOCH;
  });
  for (const path of Object.keys(overrides)) jest.dontMock(path);
  return epoch;
}

test("CORPUS_EPOCH is stable for the same rules and moves when any corpus rule changes", () => {
  const games = jest.requireActual(GAMES), visibility = jest.requireActual(VISIBILITY);
  const base = epochWith();
  expect(base).toMatch(/^1\.[0-9a-f]{16}$/);
  expect(epochWith()).toBe(base);
  const changed = [
    { [GAMES]: { ANALYSIS_GAME_PROJECTION: { ...games.ANALYSIS_GAME_PROJECTION, replayUrl: 1 } } },
    { [GAMES]: { serializeAnalysisGame: (row) => ({ ...row, date: String(row.date) }) } },
    { [VISIBILITY]: { STATS_GAME_MATCH: { ...visibility.STATS_GAME_MATCH, ranked: true } } },
    { [VISIBILITY]: { isStatsGame: (row) => visibility.isLiveGame(row) } },
  ];
  for (const overrides of changed) expect(epochWith(overrides)).not.toBe(base);
});
