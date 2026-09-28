import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: true, getToken: async (): Promise<string | null> => "token" },
  apiCall: vi.fn(),
  mutateBlocks: vi.fn(async () => undefined),
  data: {} as Record<string, unknown>,
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => harness.auth }));
vi.mock("@/lib/clientApi", () => ({
  apiCall: harness.apiCall,
  useApi: (path: string) => ({
    data: harness.data[path],
    error: undefined,
    mutate: path === "/v1/me/review-blocks" ? harness.mutateBlocks : vi.fn(),
  }),
}));
vi.mock("@/components/maps/MapArtwork", () => ({ MapArtwork: () => null }));

import { MyReviews } from "../MyReviews";

const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id, url: `/reviews/${id}`, question: `Question for ${id}`, tags: [], matchup: "PvZ", map: "Alcyone LE",
  result: "Loss", durationSec: 640, askerLabel: "Anonymous Protoss", askerBand: null, desiredLevel: "anyone",
  status: "open", reviewCount: 2, helpfulCount: 0, hasBest: false, hasPlayback: true,
  createdAt: "2026-09-27T10:00:00.000Z", lastActivityAt: null, ...extra,
});

afterEach(() => cleanup());
beforeEach(() => {
  harness.auth = { isLoaded: true, isSignedIn: true, getToken: async () => "token" };
  harness.apiCall.mockReset();
  harness.apiCall.mockResolvedValue({ ok: true });
  harness.mutateBlocks.mockClear();
  harness.data = {
    "/v1/me/reviews": {
      asked: [card("AAAAAAAAAAAAAAAA", { visibility: "link" }), card("BBBBBBBBBBBBBBBB", { hidden: true })],
      answered: [{ request: card("CCCCCCCCCCCCCCCC"), commentId: "DDDDDDDDDDDDDDDD", snippet: "Scout at 4:30.", helpful: true, best: false, upvotes: 3, createdAt: null }],
    },
    "/v1/me/review-blocks": { items: [{ id: "EEEEEEEEEEEEEEEE", name: "TrollFace", createdAt: null }] },
  };
});

describe("My reviews", () => {
  it("asks signed-out visitors to sign in", () => {
    harness.auth = { isLoaded: true, isSignedIn: false, getToken: async () => null };
    render(<MyReviews />);
    expect(screen.getByText("Sign in to see your reviews")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toContain("redirect_url=%2Freviews%2Fmine");
  });

  it("lists your requests (with link-only and hidden flags) and the reviews you wrote", () => {
    render(<MyReviews />);
    const requests = screen.getByRole("list", { name: "Your review requests" });
    expect(within(requests).getByText("Question for AAAAAAAAAAAAAAAA")).toBeTruthy();
    expect(within(requests).getByText("Link only")).toBeTruthy();
    expect(within(requests).getByText("Hidden pending review")).toBeTruthy();
    const written = screen.getByRole("list", { name: "Reviews you've written" });
    expect(within(written).getByText("Scout at 4:30.")).toBeTruthy();
    expect(within(written).getByRole("link").getAttribute("href")).toBe("/reviews/CCCCCCCCCCCCCCCC#comment-DDDDDDDDDDDDDDDD");
  });

  it("unblocks a reviewer and refreshes the list", async () => {
    render(<MyReviews />);
    const blocked = screen.getByRole("list", { name: "Blocked reviewers" });
    fireEvent.click(within(blocked).getByRole("button", { name: "Unblock" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledWith(expect.any(Function), "/v1/me/review-blocks/EEEEEEEEEEEEEEEE", { method: "DELETE" }));
    await waitFor(() => expect(harness.mutateBlocks).toHaveBeenCalled());
    expect(await screen.findByText("Unblocked TrollFace.")).toBeTruthy();
  });
});
