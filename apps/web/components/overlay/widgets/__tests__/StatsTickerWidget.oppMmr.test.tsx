/**
 * StatsTickerWidget — which opponent MMR the ticker quotes.
 *
 * Regression cover for a live-stream bug: the ticker's NOW PLAYING and
 * MMR GAP segments read ``streamerHistory.oppMmr`` (the value stamped
 * on the opponents row at the END of a PREVIOUS encounter) while the
 * opponent card directly above it read SC2Pulse's current-season
 * rating. A returning opponent who had climbed since the last meeting
 * showed two different numbers on the same scene. Both surfaces now go
 * through ``resolveLiveOpponentMmr``.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatsTickerWidget } from "../StatsTickerWidget";
import { OpponentWidget } from "../OpponentWidget";
import type { LiveGameEnvelope } from "../../types";

vi.mock("@/lib/multichat/useStudioState", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/multichat/useStudioState")>();
  return {
    ...actual,
    useStudioState: () => ({
      highlight: null,
      poll: null,
      goals: [],
      blockedUsers: [],
      recapSeq: 0,
      scene: null,
      loaded: true,
    }),
  };
});

vi.mock("@/lib/multichat/useEngagementState", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/multichat/useEngagementState")>();
  return {
    ...actual,
    useEngagementState: () => ({
      summary: actual.EMPTY_ENGAGEMENT,
      lastEvent: null,
    }),
  };
});

vi.mock("@/lib/multichat/useTickerFacts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/multichat/useTickerFacts")>();
  return { ...actual, useTickerFacts: () => [] };
});

afterEach(() => cleanup());

/** The scene from the bug report: opponent last met at 4,620, now 5,407. */
function climbedOpponent(
  profileMmr: number | null = 5407,
): LiveGameEnvelope {
  return {
    type: "liveGameState",
    phase: "match_in_progress",
    capturedAt: 1,
    opponent: {
      name: "throatGOAT",
      race: "Terran",
      profile: { region: "US", mmr: profileMmr },
    },
    streamerHistory: {
      oppName: "throatGOAT",
      matchup: "PvT",
      oppMmr: 4620,
    },
  };
}

const SESSION = {
  wins: 0,
  losses: 0,
  games: 0,
  mmrCurrent: 5295,
  region: "NA",
};

describe("StatsTickerWidget — opponent MMR source", () => {
  it("quotes the opponent's current Pulse rating, not the stored one", () => {
    render(
      <StatsTickerWidget
        token="tok"
        session={SESSION}
        liveGame={climbedOpponent()}
      />,
    );

    expect(
      screen.getAllByText(/NOW PLAYING: vs throatGOAT \(PvT\) · 5,407 MMR/)
        .length,
    ).toBeGreaterThan(0);
    expect(screen.queryAllByText(/4,620 MMR/)).toHaveLength(0);
  });

  it("measures the MMR gap against the same resolved rating", () => {
    render(
      <StatsTickerWidget
        token="tok"
        session={SESSION}
        liveGame={climbedOpponent()}
      />,
    );

    // 5407 - 5295 = +112 against the live rating; the stale 4,620 would
    // have read "opponent -675 — protect the rating".
    expect(
      screen.getAllByText(/MMR GAP: opponent \+112 — upset material/).length,
    ).toBeGreaterThan(0);
    expect(screen.queryAllByText(/protect the rating/)).toHaveLength(0);
  });

  it("falls back to the stored MMR when Pulse has no rating", () => {
    render(
      <StatsTickerWidget
        token="tok"
        session={SESSION}
        liveGame={climbedOpponent(null)}
      />,
    );

    expect(
      screen.getAllByText(/NOW PLAYING: vs throatGOAT \(PvT\) · 4,620 MMR/)
        .length,
    ).toBeGreaterThan(0);
  });

  it("omits the MMR clause when neither source has a rating", () => {
    render(
      <StatsTickerWidget
        token="tok"
        session={SESSION}
        liveGame={{
          type: "liveGameState",
          phase: "match_in_progress",
          capturedAt: 1,
          opponent: { name: "IIIIIIII", profile: { region: "US" } },
          streamerHistory: { oppName: "IIIIIIII", matchup: "PvT" },
        }}
      />,
    );

    expect(screen.getAllByText(/NOW PLAYING: vs IIIIIIII \(PvT\)$/).length)
      .toBeGreaterThan(0);
    expect(screen.queryAllByText(/MMR GAP:/)).toHaveLength(0);
  });

  it("agrees with the opponent card rendered from the same envelope", () => {
    const liveGame = climbedOpponent();
    render(<OpponentWidget live={null} liveGame={liveGame} />);
    render(
      <StatsTickerWidget token="tok" session={SESSION} liveGame={liveGame} />,
    );

    // The card prints the raw number, the ticker a grouped one — both
    // must resolve to the same rating.
    expect(screen.getAllByText(/5407 MMR/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/5,407 MMR/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/4620 MMR/)).toHaveLength(0);
    expect(screen.queryAllByText(/4,620 MMR/)).toHaveLength(0);
  });
});
