import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { AppChrome } from "../AppChrome";

const harness = vi.hoisted(() => ({
  pathname: "/app",
  me: { userId: "u1", isAdmin: false, games: { total: 50, latest: null } } as
    | Record<string, unknown>
    | undefined,
  coachingMe: { role: "none" } as
    | { role: "admin" | "coach" | "student" | "none" }
    | undefined,
  signedIn: true,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => harness.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@clerk/nextjs", () => ({
  UserButton: () => <div data-testid="user-button" />,
  SignedIn: ({ children }: { children: ReactNode }) =>
    harness.signedIn ? <>{children}</> : null,
  SignedOut: ({ children }: { children: ReactNode }) =>
    harness.signedIn ? null : <>{children}</>,
}));
vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string) => ({
    data: path === "/v1/coaching/me" ? harness.coachingMe : harness.me,
  }),
}));
vi.mock("@/components/SyncStatus", () => ({
  SyncStatus: () => <div data-testid="sync-status" />,
}));
vi.mock("@/components/ui/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("../CoachingBookingAlert", () => ({
  CoachingBookingAlert: () => <div data-testid="coaching-alert-slot" />,
}));
vi.mock("../SiteStats", () => ({
  SiteStats: ({ syncStatus }: { syncStatus?: ReactNode }) => <div data-testid="site-stats">{syncStatus}</div>,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  harness.pathname = "/app";
  harness.me = { userId: "u1", isAdmin: false, games: { total: 50, latest: null } };
  harness.coachingMe = { role: "none" };
  harness.signedIn = true;
});

const railHrefs = () =>
  Array.from(
    screen
      .getByRole("navigation", { name: "App navigation" })
      .querySelectorAll("a"),
  ).map((a) => a.getAttribute("href"));

describe("AppChrome navigation", () => {
  it("carries every product destination in one rail", () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "");
    harness.pathname = "/app/macro";
    render(<AppChrome>content</AppChrome>);

    expect(screen.getByTestId("site-stats")).toBeTruthy();

    for (const href of [
      "/app",
      "/app/replays",
      "/app/opponents",
      "/app/strategies",
      "/app/trends",
      "/app/macro",
      "/app/maps",
      "/app/builds",
      "/app/arcade",
      "/builds",
      "/community",
      "/devices",
      "/settings",
    ]) {
      expect(railHrefs()).toContain(href);
    }
    // The build guides only appear while their flag is on, and the
    // retired /meta radar has no entry at all.
    expect(railHrefs()).not.toContain("/guides");
    expect(railHrefs()).not.toContain("/meta");
    expect(railHrefs()).not.toContain("/admin");
    expect(railHrefs()).not.toContain("/coaching");
  });

  it("links the build guides after Custom builds while their flag is on", () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "on");
    harness.pathname = "/app/opponents/1-S2-1-99";
    render(<AppChrome>content</AppChrome>);

    const hrefs = railHrefs();
    expect(hrefs.indexOf("/guides")).toBe(hrefs.indexOf("/builds") + 1);
    const guides = within(screen.getByRole("navigation", { name: "App navigation" }))
      .getByRole("link", { name: "Guides" });
    expect(guides.getAttribute("href")).toBe("/guides");
    expect(guides.getAttribute("aria-current")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /More/ }));
    expect(
      within(screen.getByRole("dialog", { name: "More sections" }))
        .getByRole("link", { name: "Guides" })
        .getAttribute("href"),
    ).toBe("/guides");
  });

  it("adds Admin and Coaching immediately when /v1/me grants admin access", () => {
    harness.me = { userId: "u1", isAdmin: true, games: { total: 1, latest: null } };
    harness.coachingMe = undefined;
    render(<AppChrome>content</AppChrome>);
    expect(railHrefs()).toContain("/admin");
    expect(railHrefs()).toContain("/coaching");
  });

  it.each(["coach", "student"] as const)(
    "adds Coaching, but not Admin, for a linked %s account",
    (role) => {
      harness.coachingMe = { role };
      render(<AppChrome>content</AppChrome>);

      expect(railHrefs()).toContain("/coaching");
      expect(railHrefs()).not.toContain("/admin");
    },
  );

  it.each([undefined, { role: "none" as const }])(
    "keeps Coaching hidden when membership is unresolved or absent",
    (coachingMe) => {
      harness.coachingMe = coachingMe;
      render(<AppChrome>content</AppChrome>);
      expect(railHrefs()).not.toContain("/coaching");
    },
  );

  it("accepts the canonical admin coaching role even before /v1/me resolves", () => {
    harness.me = undefined;
    harness.coachingMe = { role: "admin" };
    render(<AppChrome>content</AppChrome>);
    expect(railHrefs()).toContain("/coaching");
    expect(railHrefs()).not.toContain("/admin");
  });

  it.each([
    ["/app/replays", "/app/replays", "Replays"],
    ["/settings", "/settings", "Settings"],
    ["/devices", "/devices", "Devices"],
    ["/builds", "/builds", "Custom builds"],
    ["/community/builds/some-slug", "/community", "Community"],
    ["/admin/users", "/admin", "Admin"],
    ["/coaching", "/coaching", "Coaching"],
    ["/app/opponents/1-S2-1-99", "/app/opponents", "Opponents"],
  ])(
    "marks %s active on its rail entry and titles it in the context bar",
    (pathname, activeHref, title) => {
      harness.pathname = pathname;
      harness.me = { userId: "u1", isAdmin: true, games: { total: 1, latest: null } };
      render(<AppChrome>content</AppChrome>);

      const active = screen
        .getByRole("navigation", { name: "App navigation" })
        .querySelector('a[aria-current="page"]');
      expect(active?.getAttribute("href")).toBe(activeHref);
      expect(screen.getByRole("banner").textContent).toContain(title);
    },
  );

  it("offers a back control on detail pages only", () => {
    harness.pathname = "/app/opponents/1-S2-1-99";
    const detail = render(<AppChrome>content</AppChrome>);
    expect(
      screen.getByRole("link", { name: "Back to Opponents" }).getAttribute("href"),
    ).toBe("/app/opponents");

    detail.unmount();
    harness.pathname = "/app/opponents";
    render(<AppChrome>content</AppChrome>);
    expect(screen.queryByRole("link", { name: /^Back to/ })).toBeNull();
  });

  it("shows live sync only on analyzer routes", () => {
    harness.pathname = "/app/trends";
    const analyzer = render(<AppChrome>content</AppChrome>);
    expect(screen.getByTestId("sync-status")).toBeTruthy();

    analyzer.unmount();
    harness.pathname = "/settings";
    render(<AppChrome>content</AppChrome>);
    expect(screen.queryByTestId("sync-status")).toBeNull();
  });
});

describe("AppChrome mobile navigation", () => {
  it("replaces the hamburger with a tab bar plus a More sheet", () => {
    harness.pathname = "/settings";
    render(<AppChrome>content</AppChrome>);

    const bar = screen.getByRole("navigation", { name: "Quick sections" });
    expect(
      Array.from(bar.querySelectorAll("a")).map((a) => a.getAttribute("href")),
    ).toEqual(["/app", "/app/opponents", "/app/trends", "/app/builds"]);

    // Settings isn't in the bar, so More carries the active treatment.
    const more = screen.getByRole("button", { name: /More/ });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(more);
    const sheet = screen.getByRole("dialog", { name: "More sections" });
    const sheetHrefs = Array.from(sheet.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    for (const href of [
      "/app/replays",
      "/app/strategies",
      "/app/maps",
      "/app/macro",
      "/app/arcade",
      "/builds",
      "/community",
      "/devices",
      "/settings",
    ]) {
      expect(sheetHrefs).toContain(href);
    }
    expect(sheetHrefs).not.toContain("/meta");
    expect(sheetHrefs).not.toContain("/coaching");
    expect(sheetHrefs).not.toContain("/app/trends");
  });

  it.each(["coach", "student"] as const)(
    "adds the linked %s Coaching destination to the mobile More sheet",
    (role) => {
      harness.pathname = "/coaching";
      harness.coachingMe = { role };
      render(<AppChrome>content</AppChrome>);

      fireEvent.click(screen.getByRole("button", { name: /More/ }));
      const sheet = screen.getByRole("dialog", { name: "More sections" });
      const coaching = within(sheet).getByRole("link", { name: "Coaching" });
      expect(coaching.getAttribute("href")).toBe("/coaching");
      expect(coaching.getAttribute("aria-current")).toBe("page");
    },
  );

  it("adds Coaching to the mobile More sheet for admins", () => {
    harness.me = { userId: "u1", isAdmin: true, games: { total: 1, latest: null } };
    harness.coachingMe = undefined;
    render(<AppChrome>content</AppChrome>);

    fireEvent.click(screen.getByRole("button", { name: /More/ }));
    expect(
      within(screen.getByRole("dialog", { name: "More sections" }))
        .getByRole("link", { name: "Coaching" }),
    ).toBeTruthy();
  });

  it("closes the sheet on Escape", () => {
    render(<AppChrome>content</AppChrome>);
    fireEvent.click(screen.getByRole("button", { name: /More/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("AppChrome for signed-out visitors", () => {
  it("keeps the shell but shows only public destinations and sign-in CTAs", () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "");
    harness.signedIn = false;
    harness.me = undefined;
    harness.pathname = "/community/builds/shared-slug";
    render(<AppChrome>content</AppChrome>);

    // Shell structure is unchanged, so nothing shifts once Clerk resolves.
    expect(screen.getByRole("navigation", { name: "App navigation" })).toBeTruthy();
    expect(screen.getByTestId("app-chrome-main")).toBeTruthy();

    expect(railHrefs()).toEqual(["/", "/community"]);
    expect(railHrefs()).not.toContain("/coaching");

    const header = screen.getByRole("banner");
    expect(within(header).getByRole("link", { name: "Sign in" })).toBeTruthy();
    expect(within(header).getByRole("link", { name: "Get started" })).toBeTruthy();
    expect(screen.queryByTestId("user-button")).toBeNull();

    // The mobile bar drops the section tabs for a sign-in entry point.
    const bar = screen.getByRole("navigation", { name: "Quick sections" });
    expect(
      Array.from(bar.querySelectorAll("a")).map((a) => a.getAttribute("href")),
    ).toEqual(["/community", "/sign-in"]);
  });

  it("offers the build guides to signed-out visitors while their flag is on", () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "on");
    harness.signedIn = false;
    harness.me = undefined;
    harness.pathname = "/community";
    render(<AppChrome>content</AppChrome>);

    expect(railHrefs()).toEqual(["/", "/guides", "/community"]);
  });
});
