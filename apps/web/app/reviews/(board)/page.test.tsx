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
vi.mock("@/components/reviews/ReviewBoardFilters", () => ({ ReviewBoardFilters: () => <div data-testid="filters" /> }));
vi.mock("@/components/reviews/ReviewBoardSidebar", () => ({ HelpWithPanel: ({ placement }: { placement: string }) => <div data-testid={`help-${placement}`} />, ReviewLeaderboard: () => null }));
vi.mock("@/components/reviews/AskGamePicker", () => ({ AskAboutGameButton: () => <button>Ask about one of your games</button> }));
vi.mock("@/components/reviews/ReviewBoardLoader", () => ({ ReviewBoardLoader: ({ query, cursor }: { query: string; cursor: string }) => <div data-testid="admin-board" data-query={query} data-cursor={cursor} /> }));

import ReviewsBoardPage, { generateMetadata } from "@/app/reviews/(board)/page";

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

  it("links the header to the full guide", async () => {
    await renderBoard();
    const link = await screen.findByRole("link", { name: "How it works" });
    expect(link.getAttribute("href")).toBe("/help/replay-reviews");
    expect(link.closest("header")).not.toBeNull();
  });
});

describe("/reviews for a signed-in player", () => {
  it("explains where asking starts, without a hover-only hint", async () => {
    harness.signedIn = true;
    await renderBoard();
    const ask = within(screen.getByRole("heading", { name: "Replay reviews" }).closest("header")!).getByRole("button", { name: "Ask about one of your games" });
    expect(ask.hasAttribute("title")).toBe(false);
    const howTo = await screen.findByRole("link", { name: "How to ask" });
    expect(howTo.getAttribute("href")).toBe("/help/replay-reviews#asking-for-a-review");
    expect((await screen.findByRole("link", { name: "How it works" })).getAttribute("href")).toBe("/help/replay-reviews");
  });

  it("uses race in shareable metadata while an exact matchup wins over a conflicting race", async () => {
    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "on");
    const race = await generateMetadata({ searchParams: Promise.resolve({ race: "P", cursor: "old", sort: "new" }) });
    expect(race.title).toBe("Protoss Replay reviews — ask about any moment of your game");
    expect(race.alternates?.canonical).toBe("/reviews?race=P");
    const matchup = await generateMetadata({ searchParams: Promise.resolve({ race: "T", matchup: "PvZ" }) });
    expect(matchup.title).toBe("PvZ Replay reviews — ask about any moment of your game");
    expect(matchup.alternates?.canonical).toBe("/reviews?matchup=PvZ");
  });

  it("renders filters, chips and both help placements in admin preview without public API reads", async () => {
    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "admins"); harness.signedIn = true;
    render(await ReviewsBoardPage({ searchParams: Promise.resolve({ race: "Z", unanswered: "1", cursor: "old" }) }));
    expect(harness.getJsonWithStatus).not.toHaveBeenCalled();
    expect(screen.getByTestId("filters")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Remove filter Race: Zerg" })).toBeTruthy();
    const board = screen.getByTestId("admin-board");
    expect(board.dataset).toMatchObject({ query: "?race=Z&unanswered=1", cursor: "old" });
    expect(screen.getByTestId("help-inline").compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("help-aside").closest("aside")).toBeTruthy();
  });

  it("sends race and cursor to the public API and renders Newest when there are no further results", async () => {
    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "on");
    harness.getJsonWithStatus.mockResolvedValue({ data: { items: [], nextCursor: null }, status: 200 });
    render(await ReviewsBoardPage({ searchParams: Promise.resolve({ race: "T", cursor: "old" }) }));
    expect(harness.getJsonWithStatus).toHaveBeenCalledWith("/v1/reviews?race=T&cursor=old", { revalidateSec: 60 });
    expect(screen.getByRole("link", { name: /Newest/ }).getAttribute("href")).toBe("/reviews?race=T");
    expect(screen.queryByRole("link", { name: /Older requests/ })).toBeNull();
  });
});
