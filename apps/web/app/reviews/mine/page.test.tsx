import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** "My reviews" links its header to the Replay reviews guide. */
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/components/reviews/MyReviews", () => ({ MyReviews: () => null }));
// This route unit runs outside the app layout; keep its actual Ask button signed out.
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false, userId: null }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: undefined, error: undefined }) }));

import MyReviewsPage from "@/app/reviews/mine/page";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("/reviews/mine", () => {
  it("offers the guide next to the way back to the board", async () => {
    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "on");
    render(<MyReviewsPage />);
    const header = screen.getByRole("heading", { level: 1, name: "My reviews" }).closest("header") as HTMLElement;
    const help = await screen.findByRole("link", { name: "How it works" });
    expect(help.getAttribute("href")).toBe("/help/replay-reviews");
    expect(header.contains(help)).toBe(true);
    expect(screen.getByRole("link", { name: "Review board" }).getAttribute("href")).toBe("/reviews");
  });
});
