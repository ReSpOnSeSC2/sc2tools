import { describe, expect, it } from "vitest";
import { parseOpeningForecast, scoutingAliases } from "../openingForecast";
const full = { top: [{ name: "12 Pool", probability: .6, samples: 3, of: 5, why: ["3 of last 5 vs you"] }], effectiveN: 4.2, confidence: "Medium", sampleSize: 5, sourceWindowSize: 6, limit: 50, otherProbability: .4, partial: false, matchup: "PvZ", map: null, prior: null };
describe("bounded forecast display contract", () => {
  it("retains true Low prior-only and explicit partial-source states", () => {
    expect(parseOpeningForecast(full)?.top[0].samples).toBe(3);
    expect(parseOpeningForecast({ ...full, confidence: "Low", effectiveN: 0, sampleSize: 0, sourceWindowSize: 0, top: [{ ...full.top[0], samples: 0, of: 0 }] })?.sampleSize).toBe(0);
    expect(parseOpeningForecast({ ...full, partial: true, reason: "source_window_truncated", top: [], otherProbability: 0 })?.partial).toBe(true);
  });
  it.each([null, { ...full, sampleSize: 51 }, { ...full, effectiveN: NaN }, { ...full, confidence: "Certain" }, { ...full, partial: true }, { ...full, top: Array(4).fill(full.top[0]) }, { ...full, otherProbability: .9 }])("malformed/new responses remain unavailable: %j", value => expect(parseOpeningForecast(value)).toBeNull());
  it("aliases carry only capped plain display text", () => {
    expect(scoutingAliases(["Alt", "Alt", " Other\u0000Name ", { token: "secret" }])).toEqual(["Alt", "Other Name"]);
    expect(scoutingAliases(Array(50).fill("x"))).toEqual(["x"]);
  });
});
