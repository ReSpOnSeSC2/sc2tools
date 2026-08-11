import { describe, expect, it } from "vitest";
import { buildProfileQuery } from "../ProfileView";

function params(query: string): URLSearchParams {
  return new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
}

describe("opponent profile query", () => {
  it("forwards the complete analyzer scope when drilling into a player", () => {
    const query = params(
      buildProfileQuery(
        {
          preset: "last_30d",
          since: "2026-07-01T00:00:00.000Z",
          until: "2026-08-01T00:00:00.000Z",
          race: "P",
          opp_race: "T",
          map_pool: "ladder",
          game_size: "1v1",
          exclude_too_short: true,
        },
        true,
      ),
    );

    expect(query.get("since")).toBe("2026-07-01T00:00:00.000Z");
    expect(query.get("until")).toBe("2026-08-01T00:00:00.000Z");
    expect(query.get("race")).toBe("P");
    expect(query.get("opp_race")).toBe("T");
    expect(query.get("map_pool")).toBe("ladder");
    expect(query.get("game_size")).toBe("1v1");
    expect(query.get("exclude_too_short")).toBe("true");
    expect(query.get("mergeLinked")).toBe("1");
    expect(query.has("preset")).toBe(false);
  });

  it("keeps explicit All as an omitted API constraint", () => {
    const query = params(
      buildProfileQuery({ map_pool: "all", game_size: "all" }),
    );
    expect(query.has("map_pool")).toBe(false);
    expect(query.has("game_size")).toBe(false);
  });
});
