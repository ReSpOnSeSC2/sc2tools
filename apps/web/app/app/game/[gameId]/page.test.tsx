import { afterEach, describe, expect, it, vi } from "vitest";
import GameDetailRoute, { generateMetadata } from "./page";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("@/components/analyzer/game/GameDetailPage", () => ({
  GameDetailPage: () => null,
}));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.apiFetch }));

afterEach(() => mocks.apiFetch.mockReset());

describe("game detail title", () => {
  const metadataFor = (gameId: string) => generateMetadata({ params: Promise.resolve({ gameId }) });

  it("names the tab after the game's result, matchup and map", async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { gameId: "g/1", result: "Defeat", myRace: "Protoss", map: "Alcyone LE", opponent: { race: "Zerg" } },
    });
    expect((await metadataFor("g%2F1")).title).toBe("Defeat · PvZ on Alcyone LE");
    const [path, init] = mocks.apiFetch.mock.calls[0];
    expect(path).toBe("/v1/games/g%2F1");
    // A cold API must not hold the title for long.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to a plain title when the game is missing or the API is down", async () => {
    mocks.apiFetch.mockResolvedValue({ ok: false, status: 404, error: "not_found" });
    expect((await metadataFor("gone")).title).toBe("Game not found");
    mocks.apiFetch.mockResolvedValue({ ok: false, status: 0, error: "network_error" });
    expect((await metadataFor("g1")).title).toBe("Game details");
    mocks.apiFetch.mockResolvedValue({ ok: true, status: 200, data: { gameId: "g1" } });
    expect((await metadataFor("g1")).title).toBe("Game details");
  });
});

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

  it("passes the Add new build side from ?newBuild and ignores anything else", async () => {
    const page = await GameDetailRoute({
      params: Promise.resolve({ gameId: "g1" }),
      searchParams: Promise.resolve({ newBuild: "opponent", t: "30" }),
    });
    expect(page.props).toMatchObject({ initialNewBuild: "opponent", initialTimeSec: 30 });

    for (const query of [{}, { newBuild: "both" }, { newBuild: "" }, { newBuild: ["you", "opponent"] }]) {
      const next = await GameDetailRoute({
        params: Promise.resolve({ gameId: "g1" }),
        searchParams: Promise.resolve(query),
      });
      expect(next.props.initialNewBuild).toBe(
        Array.isArray(query.newBuild) ? "you" : null,
      );
    }
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
