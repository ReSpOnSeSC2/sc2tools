import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The gate above a review thread says why you can't comment yet, how to
 * fix it, and links "Why?" into the Replay reviews guide. The page's
 * heavy children are stubbed; only the gate renders.
 */
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "token", isSignedIn: true, isLoaded: true, userId: "viewer" }),
}));
vi.mock("@/lib/clientApi", () => ({ apiCall: vi.fn(async () => ({})) }));
vi.mock("@/lib/usePublicApi", () => ({ usePublicApi: () => ({ data: undefined, mutate: vi.fn() }) }));
vi.mock("@/components/maps/MapArtwork", () => ({ MapArtwork: () => null }));
vi.mock("../ReviewComposer", () => ({ ReviewComposer: () => null }));
vi.mock("../ReviewReplayDownload", () => ({ ReviewReplayDownload: () => null }));
vi.mock("../ReviewReplayPanel", () => ({ ReviewReplayPanel: () => null }));
vi.mock("../ReviewShareMenu", () => ({ ReviewShareMenu: () => null }));
vi.mock("../ReviewThread", () => ({ ReviewThread: () => null }));

import { ComposerGate } from "../ReviewPage";
import type { ReviewPageData } from "@/lib/reviews";

const ID = "AAAAAAAAAAAAAAAA";

function data(
  viewer: Partial<ReviewPageData["viewer"]>,
  desiredLevel: ReviewPageData["request"]["desiredLevel"] = "anyone",
): ReviewPageData {
  return {
    request: {
      id: ID, url: `/reviews/${ID}`, question: "Why did my blink all-in fail against roaches?",
      tags: [], timeRange: null, desiredLevel, visibility: "public", status: "open", closedReason: null, hidden: false,
      asker: { label: "Anonymous Protoss", anonymous: true, band: null, mmr: null, isYou: false },
      game: { matchup: "PvZ", myRace: "Protoss", oppRace: "Zerg", map: "Alcyone LE", result: "Loss", durationSec: 640, myBuild: null, oppStrategy: null, macroScore: null, hasPlayback: false },
      opponent: { label: "Opponent (Zerg, ~4,100 MMR)", race: "Zerg", band: null, mmr: 4100 },
      stats: { reviewCount: 0, commentCount: 0, helpfulCount: 0, upvoteTotal: 0 },
      bestCommentId: null, createdAt: "2026-09-27T10:00:00.000Z", lastActivityAt: null,
    },
    comments: [],
    viewer: { signedIn: true, isAsker: false, isAdmin: false, canComment: true, reason: null, ...viewer },
    seo: { indexable: false, answerCount: 0, acceptedAnswerId: null, suggestedAnswerIds: [] },
  };
}

function renderGate(page: ReviewPageData) {
  render(<ComposerGate data={page} signedIn currentTime={312} composing={null} onStart={() => {}} />);
}

afterEach(() => cleanup());

describe("review composer gate", () => {
  it("tells a new player how many games to sync, where to get the app, and why", async () => {
    renderGate(data({ canComment: false, reason: "min_games", syncedGames: 3, requiredGames: 20 }));
    const gate = screen.getByRole("status");
    expect(gate.textContent).toContain("Sync at least 20 games with the desktop app to review replays (you have 3).");
    expect(screen.getByRole("link", { name: "Get the desktop app" }).getAttribute("href")).toBe("/download");
    const why = await screen.findByRole("link", { name: "Why? Who can review replays" });
    expect(why.getAttribute("href")).toBe("/help/replay-reviews#who-can-review");
  });

  it("falls back to the standard threshold when the API leaves it out", () => {
    renderGate(data({ canComment: false, reason: "min_games" }));
    expect(screen.getByRole("status").textContent).toContain("Sync at least 20 games with the desktop app to review replays (you have 0).");
  });

  it("explains a league requirement in plain words, with the same Why? link", async () => {
    renderGate(data({ canReview: false, reason: "level_required" }, "my_league_or_higher"));
    expect(screen.getByRole("status").textContent).toContain(
      "The asker wants reviews from verified players at their league or higher, so you can reply to existing reviews but not start a new one.",
    );
    const why = await screen.findByRole("link", { name: "Why? Who can review replays" });
    expect(why.getAttribute("href")).toBe("/help/replay-reviews#who-can-review");
    expect(screen.queryByRole("link", { name: "Get the desktop app" })).toBeNull();
  });

  it("names Masters+ as it appears in the request", () => {
    renderGate(data({ canReview: false, reason: "level_required" }, "masters_plus"));
    expect(screen.getByRole("status").textContent).toContain("The asker wants reviews from verified Masters+ players");
  });

  it("offers the comment button when nothing stands in the way", () => {
    renderGate(data({}));
    expect(screen.getByRole("button", { name: "Comment at 5:12" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
