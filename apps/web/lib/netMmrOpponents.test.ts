import { describe, expect, it } from "vitest";
import { netMmrOpponentsPath } from "./netMmrOpponents";

describe("netMmrOpponentsPath", () => {
  it("preserves analyzer filters, overrides race scope, and appends the cache revision", () => {
    const path = netMmrOpponentsPath(
      {
        race: "T",
        opp_race: "Z",
        since: "2026-07-01T00:00:00.000Z",
        preset: "all",
      },
      {
        opp_race: "P",
        search: "Dark player",
        min_pairs: 3,
        sort: "mmr_lost",
        order: "desc",
        limit: 25,
        offset: 50,
      },
      12,
    );

    expect(path).toContain("/v1/mmr-by-matchup/opponents?");
    expect(path).toContain("race=T");
    expect(path).toContain("opp_race=P");
    expect(path).not.toContain("opp_race=Z");
    expect(path).not.toContain("preset=");
    expect(path).toContain("search=Dark+player");
    expect(path).toContain("sort=mmr_lost");
    expect(path).toContain("offset=50");
    expect(path.endsWith("#12")).toBe(true);
  });
});
