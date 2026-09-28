import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { headerNavLinks } from "../headerNav";

const harness = vi.hoisted(() => ({ me: undefined as { isAdmin?: boolean } | undefined }));

vi.mock("next/navigation", () => ({ usePathname: () => "/guides/pvz" }));
vi.mock("@clerk/nextjs", () => ({
  SignedIn: () => null,
  SignedOut: ({ children }: { children: ReactNode }) => <>{children}</>,
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
});

const hrefs = (options: Parameters<typeof headerNavLinks>[0]) =>
  headerNavLinks(options).map((link) => link.href);

describe("headerNavLinks", () => {
  it("puts Guides where Meta used to be, only while guides are on", () => {
    expect(hrefs({ guides: true, reviews: false, isAdmin: false })).toEqual([
      "/app",
      "/builds",
      "/guides",
      "/community",
      "/settings",
    ]);
    expect(hrefs({ guides: false, reviews: false, isAdmin: false })).toEqual([
      "/app",
      "/builds",
      "/community",
      "/settings",
    ]);
  });

  it("keeps Reviews after Community and Admin last", () => {
    expect(hrefs({ guides: true, reviews: true, isAdmin: true })).toEqual([
      "/app",
      "/builds",
      "/guides",
      "/community",
      "/reviews",
      "/settings",
      "/admin",
    ]);
  });

  it("never links the retired /meta radar", () => {
    for (const guides of [true, false]) {
      expect(hrefs({ guides, reviews: true, isAdmin: true })).not.toContain("/meta");
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
  });
});
