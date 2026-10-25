import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import Link from "next/link";
import { AppChrome } from "../AppChrome";
import { lockBodyScroll } from "@/lib/bodyScrollLock";
import { useChromeBreadcrumb } from "../ChromeContext";

const harness = vi.hoisted(() => ({
  pathname: "/app",
  me: { userId: "u1", isAdmin: false, games: { total: 50, latest: null } } as
    | Record<string, unknown>
    | undefined,
  coachingMe: { role: "none" } as
    | { role: "admin" | "coach" | "student" | "none" }
    | undefined,
  signedIn: true,
  loaded: true,
  getToken: vi.fn(async () => null),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
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
  ClerkLoading: ({ children }: { children: ReactNode }) => harness.loaded ? null : <>{children}</>,
  SignedIn: ({ children }: { children: ReactNode }) =>
    harness.loaded && harness.signedIn ? <>{children}</> : null,
  SignedOut: ({ children }: { children: ReactNode }) =>
    harness.loaded && !harness.signedIn ? <>{children}</> : null,
}));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "http://localhost:8080",
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
// Shell layout owns the slot; the real bell and shared socket have their
// own consumer integration tests.
vi.mock("@/components/notifications/NotificationBell", () => ({ NotificationBell: () => <div data-testid="notifications-bell-slot" /> }));
vi.mock("@/components/announcements/WhatsNewButton", () => ({ WhatsNewButton: () => <div data-testid="whats-new-slot" /> }));
vi.mock("@/components/announcements/SiteIncidentBanner", () => ({ SiteIncidentBanner: () => <div data-testid="incident-banner-slot" /> }));
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
  localStorage.clear(); document.documentElement.removeAttribute("data-rail");
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  harness.pathname = "/app";
  harness.me = { userId: "u1", isAdmin: false, games: { total: 50, latest: null } };
  harness.coachingMe = { role: "none" };
  harness.signedIn = true;
  harness.loaded = true;
});

const railHrefs = () =>
  Array.from(
    screen
      .getByRole("navigation", { name: "App navigation" })
      .querySelectorAll("a"),
  ).map((a) => a.getAttribute("href"));

describe("AppChrome navigation", () => {
  it("reserves navigation and account space while Clerk loads", () => {
    harness.loaded = false; render(<AppChrome>Content</AppChrome>);
    const rail = screen.getByRole("navigation", { name: "App navigation" });
    expect(rail.querySelectorAll("a")).toHaveLength(1);
    expect(rail.querySelector("div[aria-hidden]")?.children).toHaveLength(8);
    const mobile = screen.getByRole("navigation", { name: "Quick sections" });
    expect(mobile.querySelectorAll("div[aria-hidden]")).toHaveLength(5);
    expect(screen.queryByTestId("user-button")).toBeNull();
  });
  it.each(["/app/opponents/123", "/app/game/abc"])("leaves the page's heading as the only h1 on %s", (pathname) => {
    harness.pathname = pathname;
    render(<AppChrome><h1>Detail page</h1></AppChrome>);
    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual(["Detail page"]);
  });
  it("uses the page's opponent context for both back controls and the breadcrumb", () => {
    harness.pathname = "/app/game/abc";
    function Game() {
      useChromeBreadcrumb({ backHref: "/app/opponents/123", backLabel: "Back to Serral", trail: [{ label: "Opponents", href: "/app/opponents" }, { label: "Serral", href: "/app/opponents/123" }, { label: "PvZ on Test map" }] });
      return <><h1>PvZ on Test map</h1><Link href="/app/opponents/123">Back to Serral</Link></>;
    }
    render(<AppChrome><Game /></AppChrome>);
    const back = screen.getAllByRole("link", { name: "Back to Serral" });
    expect(back).toHaveLength(2); expect(back.every((link) => link.getAttribute("href") === "/app/opponents/123")).toBe(true);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).querySelector('[aria-current="page"]')?.textContent).toBe("PvZ on Test map");
  });
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

  it("links the build guides after Build library while their flag is on", () => {
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
    ["/builds", "/builds", "Build library"],
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

  it("shows desktop status on every signed-in app surface", () => {
    harness.pathname = "/app/trends";
    const analyzer = render(<AppChrome>content</AppChrome>);
    expect(screen.getByTestId("sync-status")).toBeTruthy();

    analyzer.unmount();
    harness.pathname = "/settings";
    render(<AppChrome>content</AppChrome>);
    expect(screen.getByTestId("sync-status")).toBeTruthy();
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

  it.each(["Stream Studio", "Settings", "Search help"])("dismisses More on %s even when the pathname does not change", (name) => {
    harness.pathname = "/settings";
    render(<AppChrome>content</AppChrome>);
    fireEvent.click(screen.getByRole("button", { name: /More/ }));
    expect(document.body.style.overflow).toBe("hidden");
    const link = within(screen.getByRole("dialog", { name: "More sections" })).getByRole("link", { name });
    link.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(link);
    expect(screen.queryByRole("dialog", { name: "More sections" })).toBeNull();
    expect(document.body.style.overflow).not.toBe("hidden");
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
      "Settings",
      "Devices",
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


describe("pinned rail and accessible More", () => {
  beforeEach(() => { vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))); });
  it("persists a pin and exposes groups and tooltip descriptions without native titles", () => {
    const view = render(<AppChrome>Content</AppChrome>); const rail = screen.getByRole("navigation", { name: "App navigation" });
    expect(within(rail).getByRole("group", { name: "Analysis" })).toBeTruthy(); expect(within(rail).getByRole("group", { name: "Your setup" })).toBeTruthy();
    const link = within(rail).getByRole("link", { name: "Build stats" }); expect(link.hasAttribute("title")).toBe(false);
    expect(document.getElementById(link.getAttribute("aria-describedby")!)?.textContent).toContain("Win rates and trends");
    fireEvent.click(screen.getByRole("button", { name: "Pin sidebar" })); expect(localStorage.getItem("sc2tools:rail:v1")).toBe("pinned"); expect(document.documentElement.dataset.rail).toBe("pinned");
    expect(screen.getByRole("button", { name: "Unpin sidebar" }).getAttribute("aria-pressed")).toBe("true");
    view.unmount(); render(<AppChrome>Content</AppChrome>); expect(screen.getByRole("button", { name: "Unpin sidebar" })).toBeTruthy();
  });
  it("defaults to pinned without hover and tolerates blocked storage", () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === "(hover: none)", addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("private"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("private"); });
    render(<AppChrome>Content</AppChrome>); expect(screen.getByRole("button", { name: "Unpin sidebar" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unpin sidebar" })); expect(screen.getByRole("button", { name: "Pin sidebar" })).toBeTruthy();
  });
  it("traps the More dialog and returns focus while preserving another scroll lock", async () => {
    document.body.style.overflow = "auto"; const unlock = lockBodyScroll();
    render(<AppChrome>Content</AppChrome>); const more = screen.getByRole("button", { name: "More" }); more.focus(); fireEvent.click(more);
    const dialog = screen.getByRole("dialog", { name: "More sections" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    const radios = within(dialog).getAllByRole("radio"); radios.at(-1)!.focus(); fireEvent.keyDown(document, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    const statusLink = within(dialog).getByRole("link", { name: "System status" });
    expect(statusLink.getAttribute("href")).toBe("/status");
    expect(statusLink.getAttribute("target")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(more);
    expect(document.body.style.overflow).toBe("hidden"); unlock(); expect(document.body.style.overflow).toBe("auto"); document.body.style.overflow = "";
  });
  it("keeps short Builds mobile labels and complete avatar destinations", () => {
    render(<AppChrome>Content</AppChrome>);
    expect(within(screen.getByRole("navigation", { name: "Quick sections" })).getByRole("link", { name: "Builds" })).toBeTruthy();
    const account = screen.getByRole("list", { name: "Account menu" }); for (const name of ["Settings", "Devices", "Help"]) expect(within(account).getByRole("link", { name })).toBeTruthy();
  });
});


describe("responsive More and install availability", () => {
  it("closes More when the desktop breakpoint starts matching", () => {
    const callbacks = new Set<() => void>(); const media = { matches: false, addEventListener: (_: string, callback: () => void) => callbacks.add(callback), removeEventListener: (_: string, callback: () => void) => callbacks.delete(callback) };
    vi.stubGlobal("matchMedia", vi.fn(() => media)); render(<AppChrome>Content</AppChrome>); fireEvent.click(screen.getByRole("button", { name: "More" })); expect(screen.getByRole("dialog")).toBeTruthy();
    act(() => { media.matches = true; callbacks.forEach((callback) => callback()); }); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("uses the LogIn icon for the signed-out sign-in tab", () => {
    harness.signedIn = false; render(<AppChrome>Content</AppChrome>);
    const link = within(screen.getByRole("navigation", { name: "Quick sections" })).getByRole("link", { name: "Sign in" }); expect(link.querySelector("svg")?.classList.contains("lucide-log-in")).toBe(true);
  });
  it("hides the install row in an already installed app", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone Version/17 Mobile Safari/604");
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === "(display-mode: standalone)", addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(<AppChrome>Content</AppChrome>); fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(within(screen.getByRole("dialog", { name: "More sections" })).queryByRole("button", { name: "Install app" })).toBeNull();
  });
});
