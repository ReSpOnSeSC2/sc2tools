import { describe, expect, it } from "vitest";
import { selectedBuildId } from "../../../../api/src/services/buildIntentNativeRandomizer";
import { randomizerPool } from "../../../../api/src/services/buildIntentPrefs";
import { drawGame, mulberry32, seedFromString, spinResult } from "../engine";
import { sanitizeRandomizerConfig } from "../config";
import { playedRace, type MatchupKey } from "../types";

const RACE_MATCHUPS: MatchupKey[] = ["PvZ", "TvZ", "ZvT"];

function poolFor(matchup: MatchupKey, useCustomWeights: boolean) {
  const race = playedRace(matchup);
  return {
    enabled: true, useCustomWeights,
    builds: [
      { id: "one", name: "One", race, weight: 1 },
      { id: "two", name: "Two", race, weight: 9 },
      { id: "three", name: "Three", race, weight: 0 },
      { id: "two", name: "Second copy", race, weight: 4 },
    ],
  };
}

describe("native and OBS seeded build selection", () => {
  it.each(RACE_MATCHUPS.flatMap((matchup) => [false, true].map((weights) => [matchup, weights] as const)))(
    "keeps the same weighted winner in %s with custom weights=%s",
    (matchup, useCustomWeights) => {
      const config = sanitizeRandomizerConfig({ matchups: { [matchup]: poolFor(matchup, useCustomWeights) } });
      for (let index = 0; index < 100; index += 1) {
        const seed = `${matchup}:Opponent 🎮|Streamer|${1790000000000 + index}`;
        const expected = spinResult(matchup, config.matchups[matchup], mulberry32(seedFromString(seed)));
        expect(selectedBuildId(config.matchups[matchup], seed)).toBe(expected?.winner.id);
      }
    },
  );
});

describe("the native randomizer follows the same switches in every mode", () => {
  const units = { gateCount: 1, units: [{ id: "zealot" }, { id: "marine" }, { id: "zergling" }] };
  const MODES = [
    { name: "build only", enabled: true, unitRandomizerEnabled: false },
    { name: "units only", enabled: false, unitRandomizerEnabled: true },
    { name: "both", enabled: true, unitRandomizerEnabled: true },
  ];

  it.each(RACE_MATCHUPS.flatMap((matchup) => MODES.map((mode) => [matchup, mode.name, mode] as const)))(
    "%s, %s: a build is drawn on the server exactly when the widget draws one",
    (matchup, _name, mode) => {
      const stored = { version: 3, matchups: { [matchup]: { ...poolFor(matchup, false), ...mode, units } } };
      const config = sanitizeRandomizerConfig(stored).matchups[matchup];
      for (let index = 0; index < 20; index += 1) {
        const seed = `${matchup}:Foe|Me|${1790000000000 + index}`;
        const web = drawGame(matchup, config, mulberry32(seedFromString(seed)));
        const server = randomizerPool(stored, matchup).enabled ? selectedBuildId(stored.matchups[matchup], seed) : null;
        expect(server).toBe(web?.build?.winner.id ?? null);
        expect(web?.units === null || web?.units?.race === playedRace(matchup)).toBe(true);
        expect(Boolean(web?.units)).toBe(mode.unitRandomizerEnabled);
      }
    },
  );
});

it("preserves zero weights and shares the uniform all-zero fallback", () => {
  const sample = (weights: number[]) => {
    const raw = { enabled: true, useCustomWeights: true, builds: weights.map((weight, index) => ({
      id: String(index), name: "Build " + index, race: "Protoss", weight,
    })) };
    const config = sanitizeRandomizerConfig({ matchups: { PvZ: raw } }).matchups.PvZ;
    expect(config.builds.map((build) => build.weight)).toEqual(weights);
    return Array.from({ length: 100 }, (_, index) => {
      const seed = "fixture:" + index;
      const web = spinResult("PvZ", config, mulberry32(seedFromString(seed)))?.winner.id;
      const server = selectedBuildId(raw, seed);
      expect(server).toBe(web);
      return server;
    });
  };
  expect(new Set(sample([0, 9, 0]))).toEqual(new Set(["1"]));
  expect(new Set(sample([0, 0, 0]))).toEqual(new Set(["0", "1", "2"]));
});
