import { describe, expect, it } from "vitest";
import { ratingSparkline, signedWins, strengthDescription, sumStrength, type MatchupRatingSeries } from "../strengthAdjusted";

describe("strength result presentation", () => {
  it("formats positive, negative and rounded neutral wins without negative zero", () => {
    expect(signedWins(1.56)).toBe("+1.6"); expect(signedWins(-1.56)).toBe("−1.6"); expect(signedWins(-.01)).toBe("±0.0");
    expect(signedWins(.75)).toBe("+0.8"); expect(signedWins(-.75)).toBe("−0.8");
  });
  it("spells out rated-subset arithmetic, exclusions and actual calibration evidence", () => {
    const text = strengthDescription({ ratedGames: 4, ratedWins: 2, expectedWins: 1.5, winsAboveExpected: .5, excludedNoMmr: 3, excludedIneligible: 2, perfRating: 4200, expectation: { method: "calibrated", sampleGames: 600, supportedBins: 2, eloScale: 400 } });
    expect(text).toContain("2 rated wins − 1.50 expected wins = +0.5"); expect(text).toContain("3 missing paired ratings; 2 other ineligible");
    expect(text).toContain("600 original games in 2 supported bins"); expect(text).toContain("Performance rating 4,200");
    expect(strengthDescription({ ratedGames: 0 })).toMatch(/unavailable/);
    expect(strengthDescription({ ratedGames: 0, excludedNoMmr: 7 })).toContain("7 missing paired ratings");
    expect(strengthDescription({})).toContain("coverage has not been supplied");
  });
  it("sums disjoint subsets without averaging their performance ratings", () => {
    const result = sumStrength([{ ratedGames: 4, ratedWins: 3, expectedWins: 2, perfRating: 4400, excludedNoMmr: 1 }, { ratedGames: 2, ratedWins: 0, expectedWins: .5, perfRating: null }]);
    expect(result).toMatchObject({ ratedGames: 6, ratedWins: 3, expectedWins: 2.5, winsAboveExpected: .5, excludedNoMmr: 1 }); expect(result.perfRating).toBeUndefined();
    expect(sumStrength([{}]).ratedGames).toBeUndefined();
    expect(sumStrength([{ ratedGames: 2, ratedWins: 1, expectedWins: 1 }, {}]).expectedWins).toBeUndefined();
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
    expect(ratingSparkline([point(null), point(NaN)])).toMatchObject({ paths: [], markers: [], ticks: [], low: null, high: null });
  });
  it("places the maximum rating and its axis label above the minimum", () => {
    const plot = ratingSparkline([point(5373), point(5632), point(5400)]);
    expect(plot.low).toBe(5373); expect(plot.high).toBe(5632);
    const maximum = plot.ticks.find(tick => tick.value === 5632)!;
    const minimum = plot.ticks.find(tick => tick.value === 5373)!;
    expect(maximum.y).toBeLessThan(minimum.y);
    expect(plot.markers[1].y).toBe(maximum.y);
    expect(plot.markers[0].y).toBe(minimum.y);
  });
  it("labels the padded domain honestly for constant and narrow rating ranges", () => {
    const constant = ratingSparkline([point(4200.1), point(4200.1)]);
    expect(constant.ticks.map(tick => tick.value)).toEqual([4250.1, 4200.1, 4150.1]);
    expect(constant.markers.every(marker => marker.y === constant.ticks[1].y)).toBe(true);
    const narrow = ratingSparkline([point(4000), point(4020)]);
    expect(narrow.ticks.map(tick => tick.value)).toEqual([4060, 4010, 3960]);
    // Both observations sit inside, rather than at the endpoints of, the 100-point scale.
    expect(narrow.markers.every(marker => marker.y > narrow.ticks[0].y && marker.y < narrow.ticks[2].y)).toBe(true);
  });
});
