import { describe, expect, it } from "vitest";
import {
  buildOpponentReplayHistoryQuery,
  buildProfileQuery,
  hasUnrevealedBarcodeIdentity,
} from "../ProfileView";

function params(query: string): URLSearchParams {
  return new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
}

describe("opponent profile query", () => {
  it("offers identity leads for an unrevealed barcode with Pulse ID and MMR", () => {
    expect(
      hasUnrevealedBarcodeIdentity({
        name: "||||||||",
        revealedName: null,
        pulseCharacterId: "340886346",
        mmr: 5391,
      }),
    ).toBe(true);
  });

  it("stops offering identity leads once the barcode has a readable reveal", () => {
    expect(
      hasUnrevealedBarcodeIdentity({
        name: "IIII1111",
        revealedName: "KnownPro",
        pulseCharacterId: "340886346",
        mmr: 5391,
      }),
    ).toBe(false);
    expect(
      hasUnrevealedBarcodeIdentity({
        name: "ReadablePlayer",
        revealedName: null,
        pulseCharacterId: null,
        mmr: null,
      }),
    ).toBe(false);
  });

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

  it("adds local H2H selections to the independently paged replay feed", () => {
    const query = params(
      buildOpponentReplayHistoryQuery(
        { map_pool: "ladder", game_size: "1v1", map: "old global map" },
        true,
        "Alcyone LE",
        { myBuild: "Blink", oppStrategy: "2-1-1" },
      ),
    );

    expect(query.get("map")).toBe("Alcyone LE");
    expect(query.get("build")).toBe("Blink");
    expect(query.get("opp_strategy")).toBe("2-1-1");
    expect(query.get("map_pool")).toBe("ladder");
    expect(query.get("game_size")).toBe("1v1");
    expect(query.get("mergeLinked")).toBe("1");
  });
});
