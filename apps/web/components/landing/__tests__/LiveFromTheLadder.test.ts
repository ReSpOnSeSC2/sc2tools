import { describe, expect, it } from "vitest";
import { visibleLandingCounts } from "../LiveFromTheLadder";

describe("live ladder totals", () => {
  it("rounds down and omits small, unknown and unavailable metrics", () => {
    expect(visibleLandingCounts({
      games: 12492, communityBuilds: 24, guideGames: null, answeredReviews: 13,
      thresholds: {
        games: { min: 10000, step: 100 }, communityBuilds: { min: 25, step: 5 },
        guideGames: { min: 1000, step: 100 }, answeredReviews: { min: 10, step: 5 },
      },
    })).toEqual([
      { key: "games", label: "games analyzed", formatted: "12,400+" },
      { key: "answeredReviews", label: "answered replay reviews", formatted: "10+" },
    ]);
    expect(visibleLandingCounts(null)).toEqual([]);
    expect(visibleLandingCounts({ games: 50000, thresholds: {} })).toEqual([]);
  });
});
