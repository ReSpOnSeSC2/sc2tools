import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import type { ReactElement } from "react";
import type { MyReviewsResponse, ReviewerMe } from "@/lib/reviews";

const harness = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: true, userId: "user-a", getToken: async (): Promise<string | null> => "token" },
  apiCall: vi.fn(),
  mutateBlocks: vi.fn(async () => undefined),
  data: {} as Record<string, unknown>,
  errors: {} as Record<string, { status: number; message: string } | undefined>,
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => harness.auth }));
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  return { useSearchParams: () => new URLSearchParams(useSyncExternalStore((listener) => {
    window.addEventListener("popstate", listener); return () => window.removeEventListener("popstate", listener);
  }, () => window.location.search)) };
});
vi.mock("@/lib/clientApi", () => ({
  apiCall: harness.apiCall,
  useApi: (path: string) => ({
    data: harness.data[path],
    error: harness.errors[path],
    mutate: path === "/v1/me/review-blocks" ? harness.mutateBlocks : vi.fn(),
  }),
}));
vi.mock("@/components/maps/MapArtwork", () => ({ MapArtwork: () => null }));

import { MyReviews } from "../MyReviews";
import { MyReviewerProfile } from "../MyReviewerProfile";

const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id, url: `/reviews/${id}`, question: `Question for ${id}`, tags: [], matchup: "PvZ", map: "Alcyone LE",
  result: "Loss", durationSec: 640, askerLabel: "Anonymous Protoss", askerBand: null, desiredLevel: "anyone",
  status: "open", reviewCount: 2, helpfulCount: 0, hasBest: false, hasPlayback: true,
  createdAt: "2026-09-27T10:00:00.000Z", lastActivityAt: null, ...extra,
});

function mount(element: ReactElement = <MyReviews />) {
  const cache = new Map();
  return render(element, { wrapper: ({ children }) => <SWRConfig value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}>{children}</SWRConfig> });
}
const summary = () => harness.data["/v1/me/reviews"] as MyReviewsResponse;
const profile = (): ReviewerMe => ({ name: "Example Reviewer", stats: { karma: 42, reviews: 12, helpful: 5, best: 2, upvotes: 7, removed: 0 },
  badges: [{ key: "first", label: "First Review" }], flair: null, verified: null, verificationReason: "not_enough_ladder_games",
  canComment: false, syncedGames: 3, requiredGames: 20, leaderboardOptIn: false, weeklyDigest: true });

afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  window.history.replaceState(null, "", "/reviews/mine");
  const replace = window.history.replaceState.bind(window.history);
  vi.spyOn(window.history, "replaceState").mockImplementation((...args) => { replace(...args); window.dispatchEvent(new PopStateEvent("popstate")); });
  harness.auth = { isLoaded: true, isSignedIn: true, userId: "user-a", getToken: async () => "token" };
  harness.apiCall.mockReset();
  harness.apiCall.mockResolvedValue({ items: [], nextCursor: null });
  harness.mutateBlocks.mockClear();
  harness.errors = {};
  harness.data = {
    "/v1/me/reviews": {
      counts: { needs: 0, waiting: 0, answered: 0, closed: 0, all: 2 }, askedNextCursor: null, answeredNextCursor: null,
      asked: [card("AAAAAAAAAAAAAAAA", { visibility: "link" }), card("BBBBBBBBBBBBBBBB", { hidden: true })],
      answered: [{ request: card("CCCCCCCCCCCCCCCC"), commentId: "DDDDDDDDDDDDDDDD", snippet: "Scout at 4:30.", helpful: true, best: false, upvotes: 3, createdAt: null }],
    },
    "/v1/me/review-blocks": { items: [{ id: "EEEEEEEEEEEEEEEE", name: "TrollFace", createdAt: null }] },
  };
});

it("defaults to Needs your response when its count is positive and requests that exact section", async () => {
  summary().counts = { needs: 1, waiting: 2, answered: 3, closed: 4, all: 10 };
  harness.apiCall.mockResolvedValue({ items: [card("NEEDS")], nextCursor: null });
  mount();
  expect(screen.getByRole("tab", { name: "Needs your response (1)" }).getAttribute("aria-selected")).toBe("true");
  expect(await screen.findByText("Question for NEEDS")).toBeTruthy();
  expect(window.location.search).toBe("?tab=needs");
  expect(harness.apiCall).toHaveBeenCalledWith(expect.any(Function), "/v1/me/reviews?section=asked&tab=needs&limit=20");
  expect(screen.queryByText("Question for AAAAAAAAAAAAAAAA")).toBeNull();
  expect(screen.getByRole("tab", { name: "Closed (4)" })).toBeTruthy();
});

it("honors a copied status tab, keeps unknown query/hash context and offers each status's own empty state", async () => {
  window.history.replaceState(null, "", "/reviews/mine?tab=answered&tracking=%E2%9C%93#reviewer-profile");
  summary().counts.needs = 1;
  mount();
  expect(await screen.findByText("No best answers chosen yet")).toBeTruthy();
  for (const [label, empty] of [["Waiting for reviews", "Nothing waiting: every open request has at least one review."], ["Closed", "No closed requests"], ["Needs your response", "No reviews need your response"]]) {
    fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${label}`) }));
    expect(await screen.findByText(empty)).toBeTruthy();
  }
  fireEvent.keyDown(screen.getByRole("tab", { name: /^Needs your response/ }), { key: "End" });
  expect(screen.getByRole("tab", { name: "All (2)" })).toHaveProperty("tabIndex", 0);
  expect(new URLSearchParams(window.location.search).get("tab")).toBe("all");
  expect(new URLSearchParams(window.location.search).get("tracking")).toBe("✓");
  expect(window.location.hash).toBe("#reviewer-profile");
});

it("appends request pages without duplicating cards and preserves them while retrying a failed later page", async () => {
  summary().askedNextCursor = "asked+next";
  harness.apiCall.mockImplementation(async (_token, path: string) => {
    if (!path.includes("cursor=")) return { items: summary().asked, nextCursor: "asked+next" };
    throw { status: 503, message: "Connection interrupted" };
  });
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Load more requests" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Your review requests" })).getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Load more requests" })).toHaveProperty("disabled", true);
  harness.apiCall.mockImplementation(async (_token, path: string) => path.includes("cursor=")
    ? { items: [summary().asked[1], card("OLDER")], nextCursor: null } : { items: summary().asked, nextCursor: "asked+next" });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Question for OLDER")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Your review requests" })).getAllByRole("listitem")).toHaveLength(3);
  expect(harness.apiCall).toHaveBeenCalledWith(expect.any(Function), expect.stringContaining("cursor=asked%2Bnext"));
  expect(screen.queryByRole("button", { name: "Load more requests" })).toBeNull();
});

it("resets the written list on Most upvoted and appends its independently sorted pages", async () => {
  const written = (commentId: string, snippet: string, upvotes: number) => ({ ...summary().answered[0], commentId, snippet, upvotes });
  harness.apiCall.mockImplementation(async (_token, path: string) => path.includes("cursor=")
    ? { items: [written("TOP2", "Second most upvoted", 8)], nextCursor: null }
    : { items: [written("TOP1", "Most useful answer", 30)], nextCursor: "top-next" });
  mount();
  fireEvent.click(screen.getByRole("radio", { name: "Most upvoted" }));
  expect(screen.queryByText("Scout at 4:30.")).toBeNull();
  expect(await screen.findByText("Most useful answer")).toBeTruthy();
  expect(harness.apiCall).toHaveBeenCalledWith(expect.any(Function), "/v1/me/reviews?section=answered&sort=top&limit=20");
  fireEvent.click(screen.getByRole("button", { name: "Load more written reviews" }));
  expect(await screen.findByText("Second most upvoted")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Reviews you've written" })).getAllByRole("listitem")).toHaveLength(2);
  fireEvent.click(screen.getByRole("radio", { name: "Newest" }));
  expect(await screen.findByText("Scout at 4:30.")).toBeTruthy();
  expect(screen.queryByText("Most useful answer")).toBeNull();
});

it("can load beyond a privacy-filtered empty written page", async () => {
  summary().answered = []; summary().answeredNextCursor = "hidden-parent";
  harness.apiCall.mockResolvedValue({ items: [{ request: card("PUBLIC"), commentId: "ANSWER", snippet: "A visible answer", helpful: false, best: false, upvotes: 1, createdAt: null }], nextCursor: null });
  mount();
  expect(screen.getByText("No visible reviews on this page. Load more to continue through your history.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more written reviews" }));
  expect(await screen.findByText("A visible answer")).toBeTruthy();
});

it("does not show the previous account's cards when a pending section response completes", async () => {
  summary().counts.needs = 1;
  let resolve!: (page: unknown) => void;
  harness.apiCall.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const view = mount();
  await waitFor(() => expect(harness.apiCall).toHaveBeenCalledOnce());
  harness.auth = { ...harness.auth, userId: "user-b" };
  harness.data["/v1/me/reviews"] = { ...summary(), asked: [card("ACCOUNT-B")], answered: [], counts: { needs: 0, waiting: 0, answered: 0, closed: 0, all: 1 } };
  window.history.replaceState(null, "", "/reviews/mine?tab=all");
  view.rerender(<MyReviews />);
  expect(await screen.findByText("Question for ACCOUNT-B")).toBeTruthy();
  await act(async () => resolve({ items: [card("ACCOUNT-A-PRIVATE")], nextCursor: null }));
  expect(screen.queryByText("Question for ACCOUNT-A-PRIVATE")).toBeNull();
});

it("shows real reviewer stats, eligibility, badges, and a reason that can be acted on", () => {
  harness.data["/v1/me/reviewer"] = profile(); mount(<MyReviewerProfile />);
  const region = screen.getByRole("region", { name: "Your reviewer profile" });
  expect(within(region).getByText("Example Reviewer")).toBeTruthy();
  expect(within(region).getByText("First Review")).toBeTruthy();
  expect(within(region).getByText("Not verified yet.")).toBeTruthy();
  expect(within(region).getByText(/Sync your own ladder games/)).toBeTruthy();
  expect(within(region).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3");
  expect(within(region).getByRole("progressbar").getAttribute("aria-valuemax")).toBe("20");
  expect(within(region).getByRole("link", { name: "Get the desktop app" }).getAttribute("href")).toBe("/download");
  for (const [label, value] of [["Karma", "42"], ["Reviews", "12"], ["Helpful", "5"], ["Best", "2"], ["Upvotes", "7"]]) {
    expect(within(region).getByText(label).nextElementSibling?.textContent).toBe(value);
  }
  expect(within(region).getByRole("switch", { name: "Weekly digest of open requests in my matchups" }).getAttribute("aria-checked")).toBe("true");
});

it("focuses the reviewer profile from its direct anchor and reports completed eligibility", async () => {
  const me = profile(); me.syncedGames = 25; me.canComment = true;
  harness.data["/v1/me/reviewer"] = me;
  window.history.replaceState(null, "", "/reviews/mine#reviewer-profile");
  mount(<MyReviewerProfile />);
  const region = screen.getByRole("region", { name: "Your reviewer profile" });
  await waitFor(() => expect(document.activeElement).toBe(region));
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("20");
  expect(screen.queryByRole("link", { name: "Get the desktop app" })).toBeNull();
  expect(screen.getByText(/You meet the synced-game requirement/)).toBeTruthy();
});

describe("My reviews", () => {
  it("asks signed-out visitors to sign in", () => {
    harness.auth = { isLoaded: true, isSignedIn: false, userId: "", getToken: async () => null };
    mount();
    expect(screen.getByText("Sign in to see your reviews")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toContain("redirect_url=%2Freviews%2Fmine");
  });

  it("falls back to the sign-in prompt when Clerk never finishes loading", async () => {
    vi.useFakeTimers();
    try {
      harness.auth = { isLoaded: false, isSignedIn: false, userId: "", getToken: async () => null };
      mount();
      expect(screen.getByLabelText("Loading your reviews")).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(2000); });
      expect(screen.getByText("Sign in to see your reviews")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the blocked-reviewers card when the requests fail to load", () => {
    harness.errors["/v1/me/reviews"] = { status: 503, message: "down" };
    delete harness.data["/v1/me/reviews"];
    mount();
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(2);
    expect(screen.getByRole("list", { name: "Blocked reviewers" })).toBeTruthy();
  });

  it("shows a loading state for written reviews while the request is pending", () => {
    delete harness.data["/v1/me/reviews"];
    mount();
    expect(screen.getByLabelText("Loading reviews you've written").getAttribute("aria-busy")).toBe("true");
  });

  it("offers the in-place game picker and a secondary replay library link before the first request", () => {
    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "on");
    harness.data["/v1/me/reviews"] = { asked: [], answered: [] };
    mount();
    expect(screen.getByRole("button", { name: "Ask about one of your games" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Browse your replays" }).getAttribute("href")).toBe("/app/replays");
    fireEvent.click(screen.getByRole("button", { name: "Ask about one of your games" }));
    expect(screen.getByRole("dialog", { name: "Pick a game to ask about" })).toBeTruthy();
  });

  it("lists your requests (with link-only and hidden flags) and the reviews you wrote", () => {
    mount();
    const requests = screen.getByRole("list", { name: "Your review requests" });
    expect(within(requests).getByText("Question for AAAAAAAAAAAAAAAA")).toBeTruthy();
    expect(within(requests).getByText("Link only")).toBeTruthy();
    expect(within(requests).getByText("Hidden pending review")).toBeTruthy();
    const written = screen.getByRole("list", { name: "Reviews you've written" });
    expect(within(written).getByText("Scout at 4:30.")).toBeTruthy();
    expect(within(written).getByRole("link").getAttribute("href")).toBe("/reviews/CCCCCCCCCCCCCCCC#comment-DDDDDDDDDDDDDDDD");
  });

  it("unblocks a reviewer and refreshes the list", async () => {
    mount();
    const blocked = screen.getByRole("list", { name: "Blocked reviewers" });
    fireEvent.click(within(blocked).getByRole("button", { name: "Unblock" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledWith(expect.any(Function), "/v1/me/review-blocks/EEEEEEEEEEEEEEEE", { method: "DELETE" }));
    await waitFor(() => expect(harness.mutateBlocks).toHaveBeenCalled());
    expect(await screen.findByText("Unblocked TrollFace.")).toBeTruthy();
  });
});

it("keeps both lists visible if refreshing the dashboard summary fails", () => {
  harness.errors["/v1/me/reviews"] = { status: 503, message: "refresh interrupted" };
  mount();
  expect(screen.getByText("Question for AAAAAAAAAAAAAAAA")).toBeTruthy();
  expect(screen.getByText("Scout at 4:30.")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(2);
});
