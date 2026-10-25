import { describe, expect, it } from "vitest";
import { ratingSparkline, signedWins, strengthDescription, sumStrength, type MatchupRatingSeries } from "../strengthAdjusted";

describe("strength result presentation", () => {
  it("formats positive, negative and rounded neutral wins without negative zero", () => {
    expect(signedWins(1.56)).toBe("+1.6"); expect(signedWins(-1.56)).toBe("−1.6"); expect(signedWins(-.01)).toBe("±0.0");
  });
  it("spells out rated-subset arithmetic, exclusions and actual calibration evidence", () => {
    const text = strengthDescription({ ratedGames: 4, ratedWins: 2, expectedWins: 1.5, winsAboveExpected: .5, excludedNoMmr: 3, excludedIneligible: 2, perfRating: 4200, expectation: { method: "calibrated", sampleGames: 600, supportedBins: 2, eloScale: 400 } });
    expect(text).toContain("2 rated wins − 1.50 expected wins = +0.5"); expect(text).toContain("3 missing paired ratings; 2 other ineligible");
    expect(text).toContain("600 original games in 2 supported bins"); expect(text).toContain("Performance rating 4,200");
    expect(strengthDescription({ ratedGames: 0 })).toMatch(/unavailable/);
  });
  it("sums disjoint subsets without averaging their performance ratings", () => {
    const result = sumStrength([{ ratedGames: 4, ratedWins: 3, expectedWins: 2, perfRating: 4400, excludedNoMmr: 1 }, { ratedGames: 2, ratedWins: 0, expectedWins: .5, perfRating: null }]);
    expect(result).toMatchObject({ ratedGames: 6, ratedWins: 3, expectedWins: 2.5, winsAboveExpected: .5, excludedNoMmr: 1 }); expect(result.perfRating).toBeUndefined();
    expect(sumStrength([{}]).expectedWins).toBeNull();
  });
});

describe("game-ordered rating geometry", () => {
  const point = (perfRating: number | null) => ({ date: "2026-10-01", games: 10, ratedGames: 10, excludedNoMmr: 0, perfRating });
  it("keeps null windows as gaps and positions remaining points in game order", () => {
    const points: MatchupRatingSeries["points"] = [point(4000), point(4100), point(null), point(4200)];
    const plot = ratingSparkline(points);
    expect(plot.paths).toHaveLength(2); expect(plot.markers.map(marker => marker.index)).toEqual([0, 1, 3]);
    expect(plot.markers[0].x).toBe(5); expect(plot.markers[2].x).toBe(235); expect(plot.low).toBe(4000); expect(plot.high).toBe(4200);
  });
  it("keeps a single measured point visible and omits wholly unbounded/nonfinite windows", () => {
    expect(ratingSparkline([point(null), point(4000)]).markers).toHaveLength(1);
    expect(ratingSparkline([point(null), point(NaN)])).toMatchObject({ paths: [], markers: [], low: null, high: null });
  });
});
