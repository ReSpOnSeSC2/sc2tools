import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

/**
 * The 404 page picks its way out by auth state and by the missing
 * path. Clerk and the router are mocked; nothing else is.
 */
const harness = vi.hoisted(() => ({
  pathname: "/nowhere",
  auth: { isLoaded: true, isSignedIn: false } as { isLoaded: boolean; isSignedIn: boolean },
  useAuth: vi.fn(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => harness.pathname }));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => {
    harness.useAuth();
    return harness.auth;
  },
}));

import NotFound from "@/app/not-found";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  harness.pathname = "/nowhere";
  harness.auth = { isLoaded: true, isSignedIn: false };
  harness.useAuth.mockClear();
});

function otherPages(): string[] {
  const nav = screen.getByRole("navigation", { name: "Other pages" });
  return within(nav).getAllByRole("link").map((link) => `${link.textContent} ${link.getAttribute("href")}`);
}

describe("404 page", () => {
  it("speaks plainly and always offers Go home", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1, name: "We couldn't find that page" })).toBeTruthy();
    expect(screen.getByText("The link may be old, or the build or replay it pointed to was removed.")).toBeTruthy();
    expect(screen.queryByText(/route/i)).toBeNull();
    expect(screen.getByRole("link", { name: "Go home" }).getAttribute("href")).toBe("/");
  });

  it("never links /app for a signed-out visitor", () => {
    harness.pathname = "/app/opponents/123";
    render(<NotFound />);
    expect(document.querySelector('a[href="/app"], a[href^="/app/"]')).toBeNull();
    expect(screen.queryByRole("link", { name: /dashboard/i })).toBeNull();
  });

  it("never links /app while Clerk is still loading", () => {
    harness.auth = { isLoaded: false, isSignedIn: false };
    render(<NotFound />);
    expect(document.querySelector('a[href^="/app"]')).toBeNull();
  });

  it("offers the dashboard to a signed-in player", () => {
    harness.auth = { isLoaded: true, isSignedIn: true };
    render(<NotFound />);
    expect(screen.getByRole("link", { name: "Open dashboard" }).getAttribute("href")).toBe("/app");
  });

  it("says Back to your dashboard when the lost page was in the app", () => {
    harness.auth = { isLoaded: true, isSignedIn: true };
    harness.pathname = "/app/game/missing";
    render(<NotFound />);
    expect(screen.getByRole("link", { name: "Back to your dashboard" }).getAttribute("href")).toBe("/app");
  });

  it("lists the public pages, with /try and the guides only while they are on", () => {
    vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", "all");
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "on");
    render(<NotFound />);
    expect(otherPages()).toEqual([
      "Analyze replays in your browser /try",
      "Build guides /guides",
      "Community builds /community",
      "Download /download",
    ]);
    cleanup();
    vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", "admins");
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "");
    render(<NotFound />);
    expect(otherPages()).toEqual(["Community builds /community", "Download /download"]);
  });

  it.each([
    ["/builds/old-build", "Browse community builds /community"],
    ["/community/builds/gone", "Browse community builds /community"],
    ["/guides/pvz/gone", "Back to the guides /guides"],
    ["/p/someone/replays/x", "Community /community"],
    ["/players/someone", "Community /community"],
  ])("suggests the nearest hub first for %s", (path, first) => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "on");
    harness.pathname = path;
    render(<NotFound />);
    const links = otherPages();
    expect(links[0]).toBe(first);
    // One link per destination.
    const hrefs = links.map((link) => link.split(" ").at(-1));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("points a missing opponent profile at community builds, and your opponents when signed in", () => {
    harness.pathname = "/community/opponents/1-S2-1-1";
    render(<NotFound />);
    expect(otherPages()[0]).toBe("Browse community builds /community");
    expect(screen.queryByRole("link", { name: "Your opponents" })).toBeNull();
    cleanup();
    harness.auth = { isLoaded: true, isSignedIn: true };
    render(<NotFound />);
    expect(otherPages().slice(0, 2)).toEqual([
      "Browse community builds /community",
      "Your opponents /app/opponents",
    ]);
  });

  it("never touches Clerk on the overlay and dock routes", () => {
    harness.pathname = "/overlay/token/unknown";
    render(<NotFound />);
    expect(harness.useAuth).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Go home" })).toBeTruthy();
    expect(document.querySelector('a[href^="/app"]')).toBeNull();
  });
});
