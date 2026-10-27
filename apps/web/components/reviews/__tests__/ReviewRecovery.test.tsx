import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewPageData, ReviewerMe } from "@/lib/reviews";

const h = vi.hoisted(() => ({ apiCall: vi.fn(), mutate: vi.fn(), page: null as ReviewPageData | null,
  reviewer: null as ReviewerMe | null, reviewerMutate: vi.fn(), status: 0, reviewerError: false }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "viewer", getToken: async () => "token" }), SignedIn: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/lib/clientApi", async (original) => ({ ...await original<typeof import("@/lib/clientApi")>(), apiCall: h.apiCall, useApi: () => ({ data: h.reviewer, mutate: h.reviewerMutate, error: h.reviewerError ? { status: 500 } : undefined }) }));
vi.mock("@/lib/usePublicApi", () => ({ usePublicApi: (path: string | null) => ({ data: !path || path.includes("?race=P") ? undefined : path.endsWith("leaderboard") ? { items: [] } : path.endsWith("analysis") ? undefined : h.page,
  mutate: h.mutate, isValidating: false, error: path?.includes("?race=P") ? { status: h.status, message: "failed" } : undefined }) }));
vi.mock("@/components/maps/MapArtwork", () => ({ MapArtwork: () => null }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));
vi.mock("../ReviewShareMenu", () => ({ ReviewShareMenu: () => null }));
vi.mock("../ReviewReplayPanel", async () => {
  const { useEffect } = await import("react");
  return { ReviewReplayPanel: ({ closed, onPlaybackAvailable, onWorldClick }: { closed?: boolean; onPlaybackAvailable: (value: boolean) => void; onWorldClick?: (x: number, y: number, t: number) => void }) => {
    useEffect(() => onPlaybackAvailable(!closed), [closed, onPlaybackAvailable]);
    if (closed) return <p>This request is closed, so its replay is no longer shared.</p>;
    return <button onClick={() => onWorldClick?.(40, 60, 100)}>Place map pin</button>;
  } };
});

import { ReviewPage } from "../ReviewPage";
import { ReviewBoardLoader } from "../ReviewBoardLoader";
import { ReviewLeaderboard } from "../ReviewBoardSidebar";
import { MyReviewerProfile } from "../MyReviewerProfile";

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
  Element.prototype.scrollIntoView = vi.fn();
  h.page = fixture(); h.apiCall.mockReset(); h.mutate.mockReset(); h.mutate.mockResolvedValue(undefined);
  h.apiCall.mockResolvedValue({ id: "CCCCCCCCCCCCCCCC" }); h.status = 0; h.reviewerError = false;
  h.reviewer = { name: "Reviewer", stats: { karma: 0, reviews: 0, helpful: 0, best: 0, upvotes: 0, removed: 0 }, badges: [], verified: null,
    flair: null, leaderboardOptIn: false, weeklyDigest: false, syncedGames: 0, requiredGames: 20, canComment: false };
  h.reviewerMutate.mockReset(); h.reviewerMutate.mockImplementation(async (data) => { if (data) h.reviewer = data; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("review recovery", () => {
  it.each(["root", "reply"])("retries the thread GET after a saved %s comment without posting it twice", async (kind) => {
    h.mutate.mockRejectedValueOnce(new Error("Synthetic thread refresh failure"));
    render(<ReviewPage initial={h.page!} />);
    if (kind === "root") fireEvent.click(screen.getByRole("button", { name: "Add a note at 0:00" }));
    else fireEvent.click(within(screen.getByRole("article", { name: "Comment by Reviewer" })).getByRole("button", { name: "Reply" }));
    const form = screen.getByRole("form", { name: kind === "root" ? "Write a review comment" : "Reply" });
    fireEvent.change(within(form).getByLabelText("Comment"), { target: { value: "Saved advice should only be submitted once." } });
    fireEvent.submit(form);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Saved changes won't be submitted again"));
    expect(h.apiCall).toHaveBeenCalledOnce(); expect(screen.queryByRole("form", { name: kind === "root" ? "Write a review comment" : "Reply" })).toBeNull();
    h.page = { ...h.page!, comments: [...h.page!.comments, { ...h.page!.comments[0], id: "CCCCCCCCCCCCCCCC", parentId: kind === "root" ? null : "BBBBBBBBBBBBBBBB", body: "Saved advice should only be submitted once." }] };
    fireEvent.click(screen.getByRole("button", { name: "Retry", exact: true }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("Saved advice should only be submitted once.")).toBeTruthy();
    expect(h.apiCall).toHaveBeenCalledOnce(); expect(h.mutate).toHaveBeenCalledTimes(2);
  });

  it("removes replay and open root/reply composers immediately after a successful close even if refresh fails", async () => {
    h.page!.request.replay = { shared: true, available: true, optedIn: true };
    h.mutate.mockRejectedValueOnce(new Error("Synthetic close refresh failure"));
    render(<ReviewPage initial={h.page!} />);
    expect(screen.getByRole("button", { name: "Download replay", exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add a note at 0:00" }));
    fireEvent.click(within(screen.getByRole("article", { name: "Comment by Reviewer" })).getByRole("button", { name: "Reply" }));
    expect(screen.getAllByRole("textbox", { name: "Comment" })).toHaveLength(2);
    fireEvent.click(screen.getByText("Asker tools")); fireEvent.click(screen.getByRole("button", { name: "Close request" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Close this request?" })).getByRole("button", { name: "Close request" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Saved changes won't be submitted again"));
    expect(screen.getByText("This request is closed, so its replay is no longer shared.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Place map pin" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download replay", exact: true })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry", exact: true }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByRole("button", { name: "Download replay", exact: true })).toBeNull();
    expect(h.apiCall).toHaveBeenCalledOnce(); expect(h.mutate).toHaveBeenCalledTimes(2);
  });

  it("retries a failed close without asking for confirmation again", async () => {
    const confirm = vi.spyOn(window, "confirm");
    h.apiCall.mockRejectedValueOnce({ message: "Connection interrupted" });
    render(<ReviewPage initial={h.page!} />);
    fireEvent.click(screen.getByText("Asker tools"));
    fireEvent.click(screen.getByRole("button", { name: "Close request" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Close this request?" })).getByRole("button", { name: "Close request" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Connection interrupted"));
    expect(h.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(h.apiCall).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog", { name: "Close this request?" })).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
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
    render(<MyReviewerProfile />);
    const toggle = screen.getByRole("switch", { name: "Show my name on the weekly leaderboard" });
    await act(async () => fireEvent.click(toggle));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Couldn't save that setting. Try again.");
    expect(h.reviewerMutate.mock.calls[0][0].leaderboardOptIn).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(h.reviewerMutate.mock.calls.at(-1)?.[0].leaderboardOptIn).toBe(false);
  });

  it("links the board's karma summary to the reviewer profile instead of duplicating preferences", () => {
    h.reviewer!.stats.karma = 42;
    render(<ReviewLeaderboard initial={null} />);
    expect(screen.getByText("42 karma")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Reviewer profile & settings →" }).getAttribute("href")).toBe("/reviews/mine#reviewer-profile");
    expect(screen.queryByRole("checkbox")).toBeNull(); expect(screen.queryByRole("switch")).toBeNull();
  });

  it.each([
    ["leaderboardOptIn", "Show my name on the weekly leaderboard"],
    ["weeklyDigest", "Weekly digest of open requests in my matchups"],
  ])("saves the %s preference optimistically from the profile", async (key, label) => {
    let finish!: (value: ReviewerMe) => void;
    h.apiCall.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<MyReviewerProfile />);
    const toggle = screen.getByRole("switch", { name: label });
    await act(async () => fireEvent.click(toggle));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle).toHaveProperty("disabled", true);
    expect(h.apiCall).toHaveBeenCalledWith(expect.any(Function), "/v1/me/reviewer", { method: "PATCH", body: JSON.stringify({ [key]: true }) });
    await act(async () => finish(h.reviewer!));
    expect(toggle).toHaveProperty("disabled", false);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
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
