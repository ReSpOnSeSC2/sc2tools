import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANALYZER_FILTERS,
  filtersToQuery,
} from "../filterContext";

function params(query: string): URLSearchParams {
  return new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
}

describe("filtersToQuery", () => {
  it("serializes the ranked-ladder 1v1 defaults", () => {
    const query = params(filtersToQuery(DEFAULT_ANALYZER_FILTERS));
    expect(query.get("map_pool")).toBe("ladder");
    expect(query.get("game_size")).toBe("1v1");
    expect(query.get("exclude_too_short")).toBe("true");
    expect(query.has("preset")).toBe(false);
  });

  it("omits explicit All sentinels while retaining other filters", () => {
    const query = params(
      filtersToQuery({
        map_pool: "all",
        game_size: "all",
        regions: "NA,EU",
      }),
    );
    expect(query.has("map_pool")).toBe(false);
    expect(query.has("game_size")).toBe(false);
    expect(query.get("regions")).toBe("NA,EU");
  });
});
