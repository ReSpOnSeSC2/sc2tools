import { describe, expect, it } from "vitest";
import { conditionalRoute } from "../conditionalApiScope";

describe("private response capability positions", () => {
  it("preserves the original eleven, the four direct snapshot routes, streak and macro report, then the net-MMR pair, random summary, matchup time series and the opponent-MMR pair", () => {
    const original = ["/v1/timeseries", "/v1/timeseries/day-hour", "/v1/length-buckets",
      "/v1/activity-calendar", "/v1/momentum", "/v1/timeseries/maps", "/v1/summary",
      "/v1/macro/summary", "/v1/timeseries/mmr", "/v1/timeseries/my-builds", "/v1/timeseries/opp-strategies"];
    original.forEach((path, index) => expect(conditionalRoute(path)).toBe(index));
    ["/v1/matchups", "/v1/maps", "/v1/maps/matchups", "/v1/build-vs-strategy"]
      .forEach((path, index) => expect(conditionalRoute(`${path}?race=P`)).toBe(index + 11));
    expect([conditionalRoute("/v1/streak?race=P#3"), conditionalRoute("/v1/macro/report")]).toEqual([15, 16]);
    expect([conditionalRoute("/v1/mmr-by-matchup?group_by=matchup#2"), conditionalRoute("/v1/mmr-by-matchup/opponents?opp_race=Z")])
      .toEqual([17, 18]);
    expect(conditionalRoute("/v1/random-summary?map=x#1")).toBe(19);
    expect(conditionalRoute("/v1/timeseries/matchups?interval=day&tz=UTC&group_by=matchup#3")).toBe(20); expect([conditionalRoute("/v1/opp-mmr-buckets?bucket_width=100#4"), conditionalRoute("/v1/opp-mmr-buckets/games?lo=4300&hi=4400")]).toEqual([21, 22]);
    ["/v1/admin/global-trends/timeseries/matchups", "/v1/admin/global-trends/opp-mmr-buckets", "/v1/games-list", "/v1/me/doctor", "/v1/opponents", "/v1/custom-builds/stats"]
      .forEach(path => expect(conditionalRoute(path)).toBe(-1));
  });
});
