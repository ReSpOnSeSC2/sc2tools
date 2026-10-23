import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewPageData, ReviewerMe } from "@/lib/reviews";

const h = vi.hoisted(() => ({ apiCall: vi.fn(), mutate: vi.fn(), page: null as ReviewPageData | null,
  reviewer: null as ReviewerMe | null, reviewerMutate: vi.fn(), status: 0, reviewerError: false }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, getToken: async () => "token" }), SignedIn: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/lib/clientApi", () => ({ apiCall: h.apiCall, useApi: () => ({ data: h.reviewer, mutate: h.reviewerMutate, error: h.reviewerError ? { status: 500 } : undefined }) }));
vi.mock("@/lib/usePublicApi", () => ({ usePublicApi: (path: string) => ({ data: path.includes("?race=P") ? undefined : path.endsWith("leaderboard") ? { items: [] } : path.endsWith("analysis") ? undefined : h.page,
  mutate: h.mutate, isValidating: false, error: path.includes("?race=P") ? { status: h.status, message: "failed" } : undefined }) }));
vi.mock("@/components/maps/MapArtwork", () => ({ MapArtwork: () => null }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));
vi.mock("../ReviewShareMenu", () => ({ ReviewShareMenu: () => null }));
vi.mock("../ReviewReplayDownload", () => ({ ReviewReplayDownload: () => null }));
vi.mock("../ReviewReplayPanel", async () => {
  const { useEffect } = await import("react");
  return { ReviewReplayPanel: ({ onPlaybackAvailable, onWorldClick }: { onPlaybackAvailable: (value: boolean) => void; onWorldClick?: (x: number, y: number, t: number) => void }) => {
    useEffect(() => onPlaybackAvailable(true), [onPlaybackAvailable]);
    return <button onClick={() => onWorldClick?.(40, 60, 100)}>Place map pin</button>;
  } };
});

import { ReviewPage } from "../ReviewPage";
import { ReviewBoardLoader } from "../ReviewBoardLoader";
import { ReviewLeaderboard } from "../ReviewBoardSidebar";

function fixture(): ReviewPageData {
  return {
    request: { id: "AAAAAAAAAAAAAAAA", url: "/reviews/AAAAAAAAAAAAAAAA", question: "How should I defend this attack?", tags: [], timeRange: null,
      desiredLevel: "anyone", visibility: "public", status: "open", closedReason: null, hidden: false,
      asker: { label: "Asker", anonymous: true, band: null, mmr: null, isYou: true },
      game: { matchup: "PvZ", myRace: "Protoss", oppRace: "Zerg", map: "Alcyone LE", result: "Loss", durationSec: 640, myBuild: null, oppStrategy: null, macroScore: null, hasPlayback: true },
      opponent: { label: "Opponent", race: "Zerg", band: null, mmr: null },
      stats: { reviewCount: 1, commentCount: 1, helpfulCount: 0, upvoteTotal: 0 }, bestCommentId: null, createdAt: null, lastActivityAt: null },
    comments: [{ id: "BBBBBBBBBBBBBBBB", parentId: null, state: "visible", author: { label: "Reviewer", isAsker: false, profileHref: null, verified: null, badges: [], flair: null },
      body: "Scout the third base before moving out.", gameTimeSec: 120, endTimeSec: null, mapPoint: null, upvotes: 0, upvoted: false, helpful: false, best: false,
      mine: false, canEdit: false, createdAt: null, editedAt: null }],
    viewer: { signedIn: true, isAsker: true, isAdmin: false, canComment: true, reason: null },
    seo: { indexable: false, answerCount: 1, acceptedAnswerId: null, suggestedAnswerIds: [] },
  };
}

beforeEach(() => {
  h.page = fixture(); h.apiCall.mockReset(); h.mutate.mockReset(); h.mutate.mockResolvedValue(undefined);
  h.apiCall.mockResolvedValue({ id: "CCCCCCCCCCCCCCCC" }); h.status = 0; h.reviewerError = false;
  h.reviewer = { stats: { karma: 0 }, badges: [], verified: null, leaderboardOptIn: false, weeklyDigest: false } as unknown as ReviewerMe;
  h.reviewerMutate.mockReset(); h.reviewerMutate.mockImplementation(async (data) => { if (data) h.reviewer = data; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("review recovery", () => {
  it("retries a failed close without asking for confirmation again", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    h.apiCall.mockRejectedValueOnce({ message: "Connection interrupted" });
    render(<ReviewPage initial={h.page!} />);
    fireEvent.click(screen.getByRole("button", { name: "Close request" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Connection interrupted"));
    expect(h.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(h.apiCall).toHaveBeenCalledTimes(2));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404, 503, 0])("distinguishes preview access from failed board requests (%s)", async (status) => {
    h.status = status; render(<ReviewBoardLoader query="?race=P" />);
    if (status === 403 || status === 404) expect(screen.getByText("Reviews are in an admin-only preview.")).toBeTruthy();
    else {
      expect(screen.getByText("Couldn't load the review board")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(h.mutate).toHaveBeenCalledOnce();
    }
  });

  it("rolls an optimistic reviewer preference back after the PATCH fails", async () => {
    h.apiCall.mockRejectedValueOnce(new Error("offline"));
    render(<ReviewLeaderboard initial={null} />);
    const checkbox = screen.getByRole("checkbox", { name: "Show my name on the leaderboard" }) as HTMLInputElement;
    await act(async () => fireEvent.click(checkbox));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Couldn't save that setting. Try again.");
    expect(h.reviewerMutate.mock.calls[0][0].leaderboardOptIn).toBe(true);
    expect(checkbox.checked).toBe(false);
  });

  it("keeps the root pin when a separately pinned reply is posted", async () => {
    render(<ReviewPage initial={h.page!} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a note at 0:00" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin a spot on the map" }));
    fireEvent.click(screen.getByRole("button", { name: "Place map pin" }));
    const thread = screen.getByRole("article", { name: "Comment by Reviewer" });
    fireEvent.click(within(thread).getByRole("button", { name: "Reply" }));
    fireEvent.click(within(thread).getByRole("button", { name: "Pin a spot on the map" }));
    fireEvent.click(screen.getByRole("button", { name: "Place map pin" }));
    expect(screen.getAllByTestId("composer-pin")).toHaveLength(2);
    fireEvent.change(within(thread).getByLabelText("Comment"), { target: { value: "Hold your units back until the reinforcements arrive." } });
    const replyButtons = within(thread).getAllByRole("button", { name: "Reply" });
    fireEvent.click(replyButtons[replyButtons.length - 1]);
    await waitFor(() => expect(screen.getAllByTestId("composer-pin")).toHaveLength(1));
    expect(screen.getByTestId("composer-pin").textContent).toContain("Pinned on map");
  });
});
