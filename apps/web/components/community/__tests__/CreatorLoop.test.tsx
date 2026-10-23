import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublishCta } from "../PublishCta";
import { MyPublishedBuilds } from "../MyPublishedBuilds";
import type { OwnerBuildsResponse } from "../useOwnerBuilds";
import Link from "next/link";

const h = vi.hoisted(() => ({ loaded: true, signedIn: true, query: { data: { items: [] } as OwnerBuildsResponse | undefined, error: undefined as Error | undefined, mutate: vi.fn() }, calls: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: h.loaded, isSignedIn: h.signedIn, userId: "creator" }), SignedIn: ({ children }: { children: ReactNode }) => h.signedIn ? children : null, SignedOut: ({ children }: { children: ReactNode }) => h.signedIn ? null : children }));
vi.mock("../useOwnerBuilds", () => ({ useOwnerBuilds: () => { h.calls(); return h.query; } }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: ReactNode }) => <Link href="/help/publish-community-builds#publish-from-community">{children}</Link> }));
beforeEach(() => { h.loaded = true; h.signedIn = true; h.query.data = { items: [] }; h.query.error = undefined; h.query.mutate.mockReset(); h.calls.mockReset(); });
afterEach(cleanup);

it.each([true, false])("publishing CTA returns to the picker after signing in (signedIn=%s)", (signedIn) => {
  h.signedIn = signedIn; render(<PublishCta />);
  expect(screen.getByRole("link", { name: signedIn ? "Publish a build" : "Sign in to publish" }).getAttribute("href")).toBe(signedIn ? "/builds?publish=1" : "/sign-in?redirect_url=%2Fbuilds%3Fpublish%3D1");
  const disclosure = screen.getByRole("button", { name: "How publishing works" }); expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(disclosure); expect(disclosure.getAttribute("aria-expanded")).toBe("true"); expect(screen.getAllByRole("listitem")).toHaveLength(3);
  expect(screen.getByRole("link", { name: "Learn about publishing" }).getAttribute("href")).toContain("#publish-from-community");
  fireEvent.click(disclosure); expect(screen.queryByRole("list")).toBeNull();
});

it("Mine is account-gated and preserves its sign-in destination", () => {
  h.signedIn = false; render(<MyPublishedBuilds />);
  expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in?redirect_url=%2Fcommunity%3Fmine%3D1"); expect(h.calls).not.toHaveBeenCalled();
});

it("keeps publishing auth actions hidden until the session is resolved", () => {
  h.loaded = false; render(<PublishCta />);
  expect(screen.queryByRole("link", { name: "Publish a build" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Sign in to publish" })).toBeNull();
  expect(screen.getByRole("button", { name: "How publishing works" })).toBeTruthy();
});

it("Mine offers publishing for a verified empty answer and retries errors", () => {
  const view = render(<MyPublishedBuilds />); expect(screen.getByText("You haven't published any builds yet")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Publish a build" }).getAttribute("href")).toBe("/builds?publish=1");
  h.query.data = undefined; h.query.error = new Error("Busy"); view.rerender(<MyPublishedBuilds />);
  expect(screen.queryByText("You haven't published any builds yet")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Retry" })); expect(h.query.mutate).toHaveBeenCalledTimes(1);
});

it("Mine shows private records, votes, anonymous/moderation status and source links", () => {
  const base = { slug: "public-id", sourceSlug: "private-id", title: "Safe opening", matchup: "PvZ", votes: 5, upCount: 7, downCount: 2, total: 12, wins: 8, losses: 4, publishedAt: "2026-03-01T00:00:00Z", updatedAt: "2026-10-03T23:30:00Z", removed: true, publishAnonymously: true };
  h.query.data = { items: [{ ...base, removedByModerator: true }, { ...base, slug: "owner-removed", sourceSlug: "private-two", title: "Owner unpublished", publishAnonymously: false }] };
  const { container } = render(<MyPublishedBuilds />);
  expect(screen.getByText("Anonymous")).toBeTruthy(); expect(screen.getByText("Removed by a moderator")).toBeTruthy(); expect(screen.getByText("Not published")).toBeTruthy();
  expect(container.textContent).toContain("12 games · 8–4 · 67%"); expect(container.textContent).toContain("7 up · 2 down"); expect(container.textContent).toContain("Updated Oct 3, 2026");
  expect(screen.getAllByLabelText("Net score +5")).toHaveLength(2);
  expect(screen.getByRole("link", { name: "Safe opening" }).getAttribute("href")).toBe("/community/builds/public-id");
  expect(screen.getAllByRole("link", { name: "Edit in library" })[0].getAttribute("href")).toBe("/builds/private-id");
  expect(screen.getAllByRole("link", { name: "Publish update" })[0].getAttribute("href")).toBe("/builds?publish=private-id");
});
