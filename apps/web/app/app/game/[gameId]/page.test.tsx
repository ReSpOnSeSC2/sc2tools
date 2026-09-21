import { describe, expect, it, vi } from "vitest";
import GameDetailRoute from "./page";

vi.mock("@/components/analyzer/game/GameDetailPage", () => ({
  GameDetailPage: () => null,
}));

describe("game detail route", () => {
  it("passes the requested game time while retaining the opponent backlink", async () => {
    const page = await GameDetailRoute({
      params: Promise.resolve({ gameId: "game%2Fone" }),
      searchParams: Promise.resolve({ t: "360.5", opponent: "1-S2-1-99", opponentName: "Foe" }),
    });
    expect(page.props).toMatchObject({
      gameId: "game/one",
      initialTimeSec: 360.5,
      opponentContext: { pulseId: "1-S2-1-99", displayName: "Foe" },
    });
  });

  it("leaves ordinary and malformed deep links at their default position", async () => {
    for (const query of [{}, { t: "-5" }, { t: "Infinity" }]) {
      const page = await GameDetailRoute({
        params: Promise.resolve({ gameId: "g1" }),
        searchParams: Promise.resolve(query),
      });
      expect(page.props.initialTimeSec).toBeNull();
    }
  });
});
