import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The review board explains itself to signed-out visitors: three steps
 * and a sign-up CTA, hidden once signed in. Client children are stubbed.
 */
const harness = vi.hoisted(() => ({ signedIn: false, getJsonWithStatus: vi.fn() }));

vi.mock("@clerk/nextjs", () => ({
  SignedIn: ({ children }: { children: ReactNode }) => (harness.signedIn ? <>{children}</> : null),
  SignedOut: ({ children }: { children: ReactNode }) => (harness.signedIn ? null : <>{children}</>),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/serverApi", () => ({ getJsonWithStatus: harness.getJsonWithStatus }));
vi.mock("@/components/reviews/ReviewBoardFilters", () => ({ ReviewBoardFilters: () => null }));
vi.mock("@/components/reviews/ReviewBoardSidebar", () => ({ HelpWithList: () => null, ReviewLeaderboard: () => null }));
vi.mock("@/components/reviews/ReviewBoardLoader", () => ({ ReviewBoardLoader: () => null }));

import ReviewsBoardPage from "@/app/reviews/(board)/page";

async function renderBoard() {
  vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "on");
  harness.getJsonWithStatus.mockResolvedValue({ data: { items: [], nextCursor: null }, status: 200 });
  render(await ReviewsBoardPage({ searchParams: Promise.resolve({}) }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  harness.signedIn = false;
  harness.getJsonWithStatus.mockReset();
});

describe("/reviews for a signed-out visitor", () => {
  it("shows how the Review Exchange works in three steps", async () => {
    await renderBoard();
    const strip = screen.getByRole("region", { name: "How the Review Exchange works" });
    const steps = within(strip).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[0].textContent).toContain("Ask about a moment");
    expect(steps[1].textContent).toContain("Get answers on the replay");
    expect(steps[2].textContent).toContain("Know who is answering");
  });

  it("offers a free account that comes back to the board", async () => {
    await renderBoard();
    const strip = screen.getByRole("region", { name: "How the Review Exchange works" });
    expect(within(strip).getByRole("link", { name: "Create a free account" }).getAttribute("href")).toBe(
      "/sign-up?redirect_url=%2Freviews",
    );
    expect(within(strip).getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in?redirect_url=%2Freviews");
  });

  it("is hidden once signed in", async () => {
    harness.signedIn = true;
    await renderBoard();
    expect(screen.queryByRole("region", { name: "How the Review Exchange works" })).toBeNull();
    expect(screen.getByRole("link", { name: "My reviews" })).toBeTruthy();
  });
});
