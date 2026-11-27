import { describe, expect, it } from "vitest";
import { deriveSpinKey, gameSpin } from "@/components/overlay/widgets/RandomizerWidget";
import { sanitizeRandomizerConfig } from "../config";
import { mulberry32, seedFromString } from "../engine";
import { isMatchupKey, type MatchupKey } from "../types";
import fixture from "./unitDrawParity.json";

/**
 * The desktop loading card repeats the widget's seeded opening-unit draw in
 * the agent (build_checkin/randomizer_draw.py, tested against this same
 * fixture by tests/test_randomizer_draw.py), so a stream and the card always
 * show the same Gateway units for a game.
 */
function matchupOf(value: string): MatchupKey {
  if (!isMatchupKey(value)) throw new Error(`Not a matchup: ${value}`);
  return value;
}

describe("the widget's seeded opening-unit draw", () => {
  it.each(fixture.seeds)("seeds $text value for value", ({ text, seed, values }) => {
    expect(seedFromString(text)).toBe(seed);
    const next = mulberry32(seed);
    expect(values.map(() => next())).toEqual(values);
  });

  it.each(fixture.cases)("$name", (entry) => {
    const matchup = matchupOf(entry.matchup);
    const config = sanitizeRandomizerConfig(entry.config).matchups[matchup];
    const source = entry.buildKey.startsWith("custom:") ? "custom" : "catalog";
    const spin = gameSpin(matchup, config, `${matchup}:${entry.gameKey}`, {
      key: entry.buildKey, name: "Saved pick", source,
    });
    expect(spin?.openingUnits?.picks ?? []).toEqual(entry.units);
  });

  it("seeds a real game with its matchup and game key", () => {
    const envelope = {
      type: "liveGameState" as const, phase: "match_loading" as const,
      capturedAt: Date.now(), gameKey: "Foo|Me|1790000000000", displayTime: 0,
    };
    expect(deriveSpinKey("PvP", null, envelope)).toBe("PvP:Foo|Me|1790000000000");
  });
});
