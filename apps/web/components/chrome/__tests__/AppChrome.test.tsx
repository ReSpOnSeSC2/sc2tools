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
  getToken: vi.fn(async () => null),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => harness.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    getToken: harness.getToken,
    userId: harness.signedIn ? "clerk_u1" : null,
    isLoaded: true,
    isSignedIn: harness.signedIn,
  }),
  // The avatar menu: our items render as plain links and buttons so the
  // tests can see their order against Clerk's two defaults.
  UserButton: Object.assign(
    ({ children }: { children?: ReactNode }) => <div data-testid="user-button">{children}</div>,
    {
      MenuItems: ({ children }: { children: ReactNode }) => <ul aria-label="Account menu">{children}</ul>,
      Link: ({ label, href }: { label: string; href: string }) => (
        <li><a href={href}>{label}</a></li>
      ),
      Action: ({ label, onClick }: { label: string; onClick?: () => void }) => (
        <li>{onClick ? <button type="button" onClick={onClick}>{label}</button> : <span>{label}</span>}</li>
      ),
    },
  ),
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
vi.mock("@/components/build-checkin/BuildCheckInAlert", () => ({
  BuildCheckInAlert: () => <div data-testid="build-checkin-alert-slot" />,
}));
vi.mock("../SiteStats", () => ({
  SiteStats: ({ syncStatus }: { syncStatus?: ReactNode }) => <div data-testid="site-stats">{syncStatus}</div>,
}));
// The real form has its own tests; here it only has to open with a type.
vi.mock("@/components/feedback/LazyReportIssueModal", () => ({
  LazyReportIssueModal: ({ open, prefill, onClose }: { open: boolean; prefill?: { type?: string }; onClose: () => void }) =>
    open ? (
      <div role="dialog" aria-label="Report form" data-type={prefill?.type}>
        <button type="button" onClick={onClose}>Close form</button>
      </div>
    ) : null,
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
      "/settings?tab=overlay",
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

  it("puts the build check-in chip in the header beside the coaching alert", () => {
    harness.pathname = "/builds";
    render(<AppChrome>content</AppChrome>);
    const header = screen.getByRole("banner");
    const chip = within(header).getByTestId("build-checkin-alert-slot");
    expect(chip.nextElementSibling?.getAttribute("data-testid")).toBe("coaching-alert-slot");
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
    expect(screen.queryByTestId("build-checkin-alert-slot")).toBeNull();

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

describe("AppChrome help & support", () => {
  const reportForm = () => screen.queryByRole("dialog", { name: "Report form" });

  it("links Stream Studio from the rail without stealing Settings' active state", () => {
    harness.pathname = "/settings";
    render(<AppChrome>content</AppChrome>);
    const rail = screen.getByRole("navigation", { name: "App navigation" });
    const studio = within(rail).getByRole("link", { name: "Stream Studio" });
    expect(studio.getAttribute("href")).toBe("/settings?tab=overlay");
    expect(studio.getAttribute("aria-current")).toBeNull();
    expect(within(rail).getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
  });

  it("puts the Help & support menu between the theme toggle and the avatar", () => {
    render(<AppChrome>content</AppChrome>);
    const header = screen.getByRole("banner");
    const help = within(header).getByRole("button", { name: "Help & support" });
    expect(help.compareDocumentPosition(screen.getByTestId("user-button")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(help);
    fireEvent.click(screen.getByRole("menuitem", { name: "Suggest a feature" }));
    expect(reportForm()?.getAttribute("data-type")).toBe("idea");
  });

  it("adds Help and Report a problem above Clerk's defaults in the avatar menu", () => {
    render(<AppChrome>content</AppChrome>);
    const menu = within(screen.getByTestId("user-button")).getByRole("list", { name: "Account menu" });
    expect(Array.from(menu.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
      "Help",
      "Report a problem",
      "manageAccount",
      "signOut",
    ]);
    expect(within(menu).getByRole("link", { name: "Help" }).getAttribute("href")).toBe("/help");

    expect(reportForm()).toBeNull();
    fireEvent.click(within(menu).getByRole("button", { name: "Report a problem" }));
    expect(reportForm()?.getAttribute("data-type")).toBe("problem");
    fireEvent.click(screen.getByRole("button", { name: "Close form" }));
    expect(reportForm()).toBeNull();
  });

  it("renders the avatar menu items only when signed in", () => {
    harness.signedIn = false;
    harness.me = undefined;
    harness.pathname = "/community";
    render(<AppChrome>content</AppChrome>);
    expect(screen.queryByRole("list", { name: "Account menu" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Report a problem" })).toBeNull();

    // Visitors still get help, with the support email in place of the form.
    fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: "Help & support" }));
    expect(screen.queryByRole("menuitem", { name: "Report a problem" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Email support" }).getAttribute("href")).toBe(
      "mailto:responsecoaching@gmail.com",
    );
  });

  it("groups Help & support in the mobile More sheet and opens the form from it", () => {
    render(<AppChrome>content</AppChrome>);
    fireEvent.click(screen.getByRole("button", { name: /More/ }));
    const sheet = screen.getByRole("dialog", { name: "More sections" });
    expect(within(sheet).getByText("Help & support")).toBeTruthy();
    for (const [name, href] of [
      ["Search help", "/help"],
      ["Stream Studio crash course", "/stream-studio/learn"],
      ["Download / update the desktop app", "/download"],
      ["How reports work", "/help/report-a-problem"],
      ["Support SC2 Tools", "/donate"],
    ]) {
      expect(within(sheet).getByRole("link", { name }).getAttribute("href")).toBe(href);
    }

    fireEvent.click(within(sheet).getByRole("button", { name: "Report a problem" }));
    expect(screen.queryByRole("dialog", { name: "More sections" })).toBeNull();
    expect(reportForm()?.getAttribute("data-type")).toBe("problem");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /More/ }));
  });
});
