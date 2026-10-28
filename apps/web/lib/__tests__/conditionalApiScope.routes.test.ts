import { describe, expect, it } from "vitest";
import { conditionalRoute } from "../conditionalApiScope";

describe("private response capability positions", () => {
  it("preserves the original eleven and appends only the four direct snapshot routes", () => {
    const original = ["/v1/timeseries", "/v1/timeseries/day-hour", "/v1/length-buckets",
      "/v1/activity-calendar", "/v1/momentum", "/v1/timeseries/maps", "/v1/summary",
      "/v1/macro/summary", "/v1/timeseries/mmr", "/v1/timeseries/my-builds", "/v1/timeseries/opp-strategies"];
    original.forEach((path, index) => expect(conditionalRoute(path)).toBe(index));
    ["/v1/matchups", "/v1/maps", "/v1/maps/matchups", "/v1/build-vs-strategy"]
      .forEach((path, index) => expect(conditionalRoute(`${path}?race=P`)).toBe(index + 11));
    ["/v1/timeseries/matchups", "/v1/opp-mmr-buckets", "/v1/me/doctor", "/v1/opponents", "/v1/custom-builds/stats"]
      .forEach(path => expect(conditionalRoute(path)).toBe(-1));
  });
});
