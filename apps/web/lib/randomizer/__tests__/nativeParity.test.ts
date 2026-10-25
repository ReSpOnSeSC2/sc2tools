import { describe, expect, it } from "vitest";
import { selectedBuildId } from "../../../../api/src/services/buildIntentNativeRandomizer";
import { mulberry32, seedFromString, spinResult } from "../engine";
import { sanitizeRandomizerConfig } from "../config";

describe("native and OBS seeded build selection", () => {
  it.each([false, true])("keeps the same weighted winner with custom weights=%s", (useCustomWeights) => {
    const config = sanitizeRandomizerConfig({ matchups: { PvZ: {
      enabled: true, useCustomWeights,
      builds: [
        { id: "one", name: "One", race: "Protoss", weight: 1 },
        { id: "two", name: "Two", race: "Protoss", weight: 9 },
        { id: "three", name: "Three", race: "Protoss", weight: 0 },
        { id: "two", name: "Second copy", race: "Protoss", weight: 4 },
      ],
    } } });
    for (let index = 0; index < 100; index += 1) {
      const seed = `PvZ:Opponent 🎮|Streamer|${1790000000000 + index}`;
      const expected = spinResult("PvZ", config.matchups.PvZ, mulberry32(seedFromString(seed)));
      expect(selectedBuildId(config.matchups.PvZ, seed)).toBe(expected?.winner.id);
    }
  });
});
