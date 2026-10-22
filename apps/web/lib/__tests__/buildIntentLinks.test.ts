import { describe, expect, it } from "vitest";
import {
  NEW_BUILD_QUERY_PARAM,
  newBuildHref,
  newBuildSideFromQuery,
  withoutNewBuildParam,
} from "../buildIntentLinks";

describe("newBuildHref", () => {
  it("encodes the game id and names the side", () => {
    expect(newBuildHref("g1", "you")).toBe("/app/game/g1?newBuild=you");
    expect(newBuildHref("2026|a b/c", "opponent")).toBe(
      "/app/game/2026%7Ca%20b%2Fc?newBuild=opponent",
    );
    expect(NEW_BUILD_QUERY_PARAM).toBe("newBuild");
  });
});

describe("newBuildSideFromQuery", () => {
  it("accepts exactly you or opponent", () => {
    expect(newBuildSideFromQuery({ newBuild: "you" })).toBe("you");
    expect(newBuildSideFromQuery({ newBuild: " opponent " })).toBe("opponent");
    expect(newBuildSideFromQuery({ newBuild: ["opponent", "you"] })).toBe("opponent");
  });

  it("ignores missing, empty and unknown values", () => {
    for (const query of [
      {},
      { newBuild: "" },
      { newBuild: "Opponent" },
      { newBuild: "both" },
      { newBuild: [] },
      { newBuild: undefined },
      { side: "you" },
    ]) {
      expect(newBuildSideFromQuery(query)).toBeNull();
    }
  });
});

describe("withoutNewBuildParam", () => {
  it("drops only the deep link and keeps the rest of the location", () => {
    expect(withoutNewBuildParam("/app/game/g1", "?newBuild=you")).toBe("/app/game/g1");
    expect(
      withoutNewBuildParam(
        "/app/game/g1",
        "?t=90&newBuild=opponent&opponent=1-S2-1-9&opponentName=Foe",
        "#timeline",
      ),
    ).toBe("/app/game/g1?t=90&opponent=1-S2-1-9&opponentName=Foe#timeline");
    expect(withoutNewBuildParam("/app/game/g1", "")).toBe("/app/game/g1");
  });
});
