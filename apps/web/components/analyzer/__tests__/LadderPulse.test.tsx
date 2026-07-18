import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { MetaRow } from "@/lib/meta";
import type { PulseGamesPage } from "@/lib/ladderPulse";
import { LadderPulse } from "../LadderPulse";

const useApiMock = vi.fn();
const mutateGames = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

vi.mock("@/lib/filterContext", () => ({
  useFilters: () => ({ dbRev: 7 }),
}));

vi.mock("../arcade/hooks/useDailySeed", () => ({
  useDailySeed: () => ({
    userId: "user-1",
    day: "2026-07-18",
    tz: "America/New_York",
    rng: () => 0.5,
  }),
}));

vi.mock("@/components/maps/MapArtwork", () => ({
  MapLabel: ({ name }: { name?: string | null }) => (
    <span data-testid="map-label">{name || "Unknown map"}</span>
  ),
}));

const META_ROW: MetaRow = {
  era: "after",
  bandType: "league",
  band: 4,
  bandLabel: "Diamond",
  leagueBand: 4,
  league: "Diamond",
  matchup: "PvZ",
  n: 120,
  updatedAt: "2026-07-18T12:00:00.000Z",
  prevUpdatedAt: "2026-07-11T12:00:00.000Z",
  openers: [
    {
      build: "PvZ - Immortal Timing",
      games: 30,
      wins: 18,
      losses: 12,
      winRate: 0.6,
      frequency: 0.25,
      winRateDelta: 0.03,
      freqDelta: 0.05,
      isNew: false,
    },
  ],
};

const GAMES: PulseGamesPage = {
  items: [
    {
      gameId: "g/new",
      date: "2026-07-18T15:45:00.000Z",
      result: "Victory",
      map: "Ruby Rock LE",
      durationSec: 754,
      myRace: "Protoss",
      myLadderRace: "Protoss",
      myToonHandle: "1-S2-1-100",
      myBuild: "PvZ - Stargate into Glaives",
      myMmr: 4122,
      myMmrSource: "replay",
      macroScore: 84,
      top3Leaks: [
        {
          name: "Supply blocked",
          mineral_cost: 320,
        },
      ],
      opponent: {
        pulseId: "opp-alpha",
        displayName: "Alpha",
        race: "Zerg",
        leagueId: 4,
        mmr: 4170,
        strategy: "ZvP - Roach Pressure",
      },
    },
    {
      gameId: "g-old-1",
      date: "2026-07-18T14:00:00.000Z",
      result: "Defeat",
      map: "Persepolis LE",
      durationSec: 680,
      myRace: "Protoss",
      myLadderRace: "Protoss",
      myToonHandle: "1-S2-1-100",
      myBuild: "PvZ - Stargate into Glaives",
      myMmr: 4100,
      myMmrSource: "replay",
      opponent: {
        displayName: "Beta",
        race: "Zerg",
        strategy: "ZvP - Hydra Timing",
      },
    },
    {
      gameId: "g-old-2",
      date: "2026-07-18T13:00:00.000Z",
      result: "Victory",
      map: "Amygdala LE",
      durationSec: 900,
      myRace: "Protoss",
      myLadderRace: "Protoss",
      myToonHandle: "1-S2-1-100",
      myBuild: "PvZ - Stargate into Glaives",
      myMmr: 4075,
      myMmrSource: "replay",
      opponent: {
        displayName: "Gamma",
        race: "Zerg",
        strategy: "ZvP - Macro",
      },
    },
  ],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-18T16:00:00.000Z"));
  mutateGames.mockReset();
  useApiMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function wire(args?: {
  games?: PulseGamesPage;
  gamesLoading?: boolean;
  gamesError?: { message: string };
  meta?: MetaRow | null;
  metaLoading?: boolean;
  metaError?: { message: string };
}) {
  const opts = args ?? {};
  useApiMock.mockImplementation((path: string | null) => {
    if (path?.startsWith("/v1/games?")) {
      return {
        data: opts.games,
        isLoading: opts.gamesLoading ?? false,
        error: opts.gamesError,
        mutate: mutateGames,
      };
    }
    if (path?.startsWith("/v1/meta/ladder?")) {
      return {
        data: opts.meta ? { row: opts.meta } : undefined,
        isLoading: opts.metaLoading ?? false,
        error: opts.metaError,
      };
    }
    return { data: undefined, isLoading: false };
  });
}

describe("LadderPulse", () => {
  it("renders the newest real replay, verified MMR delta, daily replay, and live meta movement", () => {
    wire({ games: GAMES, meta: META_ROW });
    render(<LadderPulse />);

    expect(useApiMock).toHaveBeenCalledWith(
      "/v1/games?limit=40#7",
      expect.objectContaining({ keepPreviousData: true }),
    );
    expect(useApiMock).toHaveBeenCalledWith(
      "/v1/meta/ladder?axis=league&band=4&matchup=PvZ&era=after",
      expect.objectContaining({ refreshInterval: 3_600_000 }),
    );

    expect(screen.getByText(/Victory secured/)).toBeTruthy();
    expect(screen.getByText("vs Alpha")).toBeTruthy();
    expect(screen.getByText("Just in")).toBeTruthy();
    const mmr = screen.getByText("MMR 4,122 · +22 vs prior");
    expect(mmr).toBeTruthy();
    expect(mmr.parentElement?.getAttribute("title")).toContain(
      "prior replay",
    );
    expect(screen.getByText("Macro 84")).toBeTruthy();
    expect(screen.getByText(/Supply blocked/)).toBeTruthy();
    expect(screen.getByText("Immortal Timing")).toBeTruthy();
    expect(screen.getByText("Usage +5.0 pts week over week")).toBeTruthy();

    const fullAnalysis = screen.getByRole("link", {
      name: /Open full analysis/i,
    });
    expect(fullAnalysis.getAttribute("href")).toBe("/app/game/g%2Fnew");

    const daily = screen.getByRole("complementary", {
      name: "Daily replay",
    });
    expect(
      within(daily).getByRole("link", { name: /Reopen replay/i }),
    ).toBeTruthy();

    const metaLink = screen.getByRole("link", {
      name: /Open meta radar/i,
    });
    expect(metaLink.getAttribute("href")).toBe(
      "/meta?axis=league&band=4&matchup=PvZ&era=after",
    );
  });

  it("does not call an old imported replay fresh and shows factual personal form when meta is unavailable", () => {
    const stale: PulseGamesPage = {
      items: GAMES.items!.map((row, index) => ({
        ...row,
        date: `2025-01-0${index + 1}T12:00:00.000Z`,
      })),
    };
    wire({
      games: stale,
      meta: null,
      metaError: { message: "not enough data" },
    });
    render(<LadderPulse />);

    expect(screen.queryByText("Just in")).toBeNull();
    const form = screen.getByRole("complementary", {
      name: "Recent form",
    });
    expect(within(form).getByText("Stargate into Glaives")).toBeTruthy();
    expect(within(form).getByText("2-1")).toBeTruthy();
    expect(
      within(form).getByText(
        "3 appearances in your latest 3 synced games",
      ),
    ).toBeTruthy();
  });

  it("renders accessible loading and first-replay empty states", () => {
    wire({ gamesLoading: true });
    render(<LadderPulse />);
    expect(
      screen.getByLabelText("Loading Ladder Pulse").getAttribute("aria-busy"),
    ).toBe("true");

    cleanup();
    wire({ games: { items: [] } });
    render(<LadderPulse />);
    expect(
      screen.getByText("Your Ladder Pulse starts with a replay"),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Get the agent/i }).getAttribute("href"),
    ).toBe("/download");
  });

  it("surfaces replay-fetch errors and retries through SWR", () => {
    wire({
      gamesError: { message: "Replay service unavailable." },
    });
    render(<LadderPulse />);

    expect(screen.getByText("Ladder Pulse is temporarily quiet")).toBeTruthy();
    expect(screen.getByText("Replay service unavailable.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mutateGames).toHaveBeenCalledTimes(1);
  });
});
