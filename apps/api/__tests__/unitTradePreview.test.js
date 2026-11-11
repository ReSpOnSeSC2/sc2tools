"use strict";

const { compactTradeReplay, tradeSample, hasTradeEngine } = require("../src/services/unitTradePreview");

test("trade previews keep bounded own-side counts and omit replay and player identifiers", () => {
  const game = { gameId: "raw|OppName|Map", myRace: "Terran", opponent: { race: "Zerg", displayName: "OppName" } };
  const row = compactTradeReplay(game, { casualty_events: [
    { time: 10, bornAt: 5, owner: "me", killer: "opp", category: "units", name: "Marine" },
    { time: 20, owner: "opp", killer: "me", killerUnit: "Marine", category: "units", name: "Roach" },
    { time: 21, owner: "opp", killer: "me", killerUnit: "Marine", category: "units", name: "Roach" },
    { time: 22, owner: "opp", killer: "me", category: "units", name: "Roach" },
  ] });
  expect(row).toEqual({ matchup: "TvZ", era: null,
    kills: [{ unit: "Marine", target: "Roach", count: 2 }], losses: [{ unit: "Marine", count: 1 }] });
  expect(tradeSample([{ tradeSample: row }, { tradeSample: null }])).toEqual({ selected: 2, replays: [row] });
  expect(compactTradeReplay(game, { casualty_events: [] })).toBeNull();
  expect(hasTradeEngine("1.6.12")).toBe(false);
  expect(hasTradeEngine("1.6.13")).toBe(true);
  expect(hasTradeEngine("1.10.0")).toBe(true);
});
