import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { headerNavLinks } from "../headerNav";

const harness = vi.hoisted(() => ({
  me: undefined as { isAdmin?: boolean } | undefined,
  signedIn: false,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/guides/pvz",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@clerk/nextjs", () => ({
  SignedIn: ({ children }: { children: ReactNode }) => (harness.signedIn ? <>{children}</> : null),
  SignedOut: ({ children }: { children: ReactNode }) => (harness.signedIn ? null : <>{children}</>),
  UserButton: () => null,
}));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: harness.me }) }));
vi.mock("@/components/ui/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("../CoachingBookingAlert", () => ({ CoachingBookingAlert: () => null }));
vi.mock("@/components/notifications/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("../MobileNav", () => ({ MobileNav: () => null }));

import { Header } from "../Header";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  harness.me = undefined;
  harness.signedIn = false;
});

type Options = Parameters<typeof headerNavLinks>[0];

/** The hrefs one audience sees, in order. */
function hrefsFor(options: Options, signedIn: boolean): string[] {
  return headerNavLinks(options)
    .filter((link) => link.auth === "any" || (signedIn ? link.auth !== "out" : link.auth === "out"))
    .map((link) => link.href);
}

describe("headerNavLinks", () => {
  it("gives signed-in players their own links and no Dashboard link", () => {
    expect(hrefsFor({ guides: true, reviews: false, isAdmin: false }, true)).toEqual([
      "/builds",
      "/guides",
      "/community",
      "/help",
      "/settings",
    ]);
    expect(hrefsFor({ guides: true, reviews: true, isAdmin: true }, true)).not.toContain("/app");
  });

  it("gives visitors Analyze replays, Stream Studio and Download, never an account page", () => {
    expect(hrefsFor({ guides: true, reviews: true, isAdmin: false, tryPage: true }, false)).toEqual([
      "/try",
      "/stream-studio",
      "/guides",
      "/community",
      "/reviews",
      "/help",
      "/download",
    ]);
    for (const href of hrefsFor({ guides: true, reviews: true, isAdmin: false, tryPage: true }, false)) {
      expect(["/app", "/builds", "/settings", "/devices", "/welcome"]).not.toContain(href);
    }
  });

  it("lists /try only while Instant Analysis is open to everyone", () => {
    expect(hrefsFor({ guides: false, reviews: false, isAdmin: false, tryPage: false }, false)).toEqual([
      "/stream-studio",
      "/community",
      "/help",
      "/download",
    ]);
    const tryLink = headerNavLinks({ guides: false, reviews: false, isAdmin: false, tryPage: true })[0];
    expect(tryLink).toEqual({ href: "/try", label: "Analyze replays", auth: "out" });
  });

  it("keeps Reviews after Community, Help before Settings and Admin last", () => {
    expect(hrefsFor({ guides: true, reviews: true, isAdmin: true }, true)).toEqual([
      "/builds",
      "/guides",
      "/community",
      "/reviews",
      "/help",
      "/settings",
      "/admin",
    ]);
  });

  it("shows Help to everyone and holds Help and Download for the wide header", () => {
    const links = headerNavLinks({ guides: false, reviews: false, isAdmin: false });
    expect(links.find((link) => link.href === "/help")).toEqual({ href: "/help", label: "Help", auth: "any", wideOnly: true });
    expect(links.filter((link) => link.wideOnly).map((link) => link.href)).toEqual(["/help", "/download"]);
  });

  it("never links the retired /meta radar", () => {
    for (const guides of [true, false]) {
      expect(headerNavLinks({ guides, reviews: true, isAdmin: true, tryPage: true }).map((l) => l.href)).not.toContain("/meta");
    }
  });

  it("shows Guides to signed-out visitors", () => {
    const guides = headerNavLinks({ guides: true, reviews: false, isAdmin: false }).find(
      (link) => link.href === "/guides",
    );
    expect(guides).toEqual({ href: "/guides", label: "Guides", auth: "any" });
  });
});

describe("Header", () => {
  it("renders the Guides link (active on a guide page) when the flag is on", () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "on");
    render(<Header />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const guides = within(nav).getByRole("link", { name: "Guides" });
    expect(guides.getAttribute("href")).toBe("/guides");
    // usePathname() is "/guides/pvz": a guide page marks Guides as current.
    expect(guides.getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: "Community" }).getAttribute("aria-current")).toBeNull();
    expect(within(nav).queryByRole("link", { name: "Meta" })).toBeNull();
  });

  it("hides the Guides link when the flag is off", () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "");
    render(<Header />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).queryByRole("link", { name: "Guides" })).toBeNull();
    expect(within(nav).getByRole("link", { name: "Community" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Help" }).getAttribute("href")).toBe("/help");
  });

  it("shows visitors the public pages and sign-in CTAs, with no link into the app", () => {
    vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", "all");
    render(<Header />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Analyze replays" }).getAttribute("href")).toBe("/try");
    expect(within(nav).getByRole("link", { name: "Stream Studio" }).getAttribute("href")).toBe("/stream-studio");
    const download = within(nav).getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toBe("/download");
    // No room for it in the lg row: it joins the nav from xl.
    expect(download.className).toContain("hidden");
    expect(download.className).toContain("xl:inline-flex");
    expect(within(nav).queryByRole("link", { name: "Build library" })).toBeNull();
    expect(within(nav).queryByRole("link", { name: "Settings" })).toBeNull();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in?redirect_url=%2Fguides%2Fpvz");
    expect(screen.getByRole("link", { name: "Get started" }).getAttribute("href")).toBe("/sign-up?redirect_url=%2Fguides%2Fpvz");
    expect(screen.queryByRole("link", { name: "Open app" })).toBeNull();
    expect(document.querySelector('a[href="/app"]')).toBeNull();
  });

  it("hides Analyze replays until Instant Analysis is open to everyone", () => {
    vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", "admins");
    render(<Header />);
    expect(screen.queryByRole("link", { name: "Analyze replays" })).toBeNull();
  });

  it("gives signed-in players an Open app pill instead of a Dashboard link", () => {
    harness.signedIn = true;
    render(<Header />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).queryByRole("link", { name: "Dashboard" })).toBeNull();
    expect(within(nav).getByRole("link", { name: "Build library" }).getAttribute("href")).toBe("/builds");
    expect(within(nav).queryByRole("link", { name: "Stream Studio" })).toBeNull();
    expect(within(nav).queryByRole("link", { name: "Download" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open app" }).getAttribute("href")).toBe("/app");
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });
});
