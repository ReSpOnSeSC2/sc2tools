/**
 * The app's bottom layer: AppChrome measures the mobile tab bar and
 * publishes --chrome-bottom on <html>; the Save bar, toasts, the update
 * prompt and the cookie banner float `bottom-above-chrome`, so on a
 * phone they sit above the tab bar instead of underneath it. jsdom does
 * no layout, so the tab bar's height is stubbed and the token's CSS is
 * evaluated with the published value (see ../../ui/__tests__/bottomLayer).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { AppChrome } from "../AppChrome";
import { CHROME_BOTTOM_VAR } from "../chromeInsets";
import { CookieBanner } from "@/components/CookieBanner";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { Z_LAYERS, aboveChromeBottomPx } from "@/components/ui/__tests__/bottomLayer";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/settings",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => null, userId: "u1", isLoaded: true, isSignedIn: true }),
  UserButton: Object.assign(() => null, { MenuItems: () => null, Link: () => null, Action: () => null }),
  ClerkLoading: () => null,
  SignedIn: ({ children }: { children: ReactNode }) => <>{children}</>,
  SignedOut: () => null,
}));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "http://localhost:8080", useApi: () => ({ data: undefined }) }));
vi.mock("@/components/SyncStatus", () => ({ SyncStatus: () => null }));
vi.mock("@/components/ui/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("../CoachingBookingAlert", () => ({ CoachingBookingAlert: () => null }));
vi.mock("@/components/build-checkin/BuildCheckInAlert", () => ({ BuildCheckInAlert: () => null }));
vi.mock("@/components/notifications/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/announcements/WhatsNewButton", () => ({ WhatsNewButton: () => null }));
vi.mock("@/components/announcements/SiteIncidentBanner", () => ({ SiteIncidentBanner: () => null }));
vi.mock("../SiteStats", () => ({ SiteStats: () => null }));
vi.mock("@/lib/analytics/consent", () => ({
  COOKIE_SETTINGS_EVENT: "sc2tools:open-cookie-settings",
  withdrawConsent: vi.fn(),
  isAnalyticsConfigured: () => true,
  readConsent: () => "unset",
  setConsent: vi.fn(),
  subscribeConsent: () => () => {},
}));

/** The mobile tab bar's rendered height; 0 once md:hidden applies. */
let tabBarHeight = 64;
let resize: (() => void) | null = null;

class FakeResizeObserver {
  constructor(private readonly callback: () => void) {
    resize = () => this.callback();
  }
  observe() {}
  disconnect() {
    resize = null;
  }
}

beforeEach(() => {
  tabBarHeight = 64;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const height = this.getAttribute("aria-label") === "Quick sections" ? tabBarHeight : 0;
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 390, height, toJSON: () => ({}) } as DOMRect;
  });
  window.innerWidth = 390;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty(CHROME_BOTTOM_VAR);
});

const chromeBottom = () => document.documentElement.style.getPropertyValue(CHROME_BOTTOM_VAR) || null;

describe("--chrome-bottom", () => {
  it("is the tab bar's height while the app chrome is mounted, and unset after", () => {
    const view = render(<AppChrome>content</AppChrome>);
    expect(chromeBottom()).toBe("64px");
    view.unmount();
    // Marketing pages: no tab bar, the safe area alone applies.
    expect(chromeBottom()).toBeNull();
  });

  it("follows the tab bar's size and is 0 on md+ where the bar is hidden", () => {
    render(<AppChrome>content</AppChrome>);
    tabBarHeight = 98; // home indicator padding added
    act(() => resize?.());
    expect(chromeBottom()).toBe("98px");
    tabBarHeight = 0; // md:hidden
    act(() => resize?.());
    expect(chromeBottom()).toBe("0px");
    expect(aboveChromeBottomPx(chromeBottom())).toBe(12);
  });

  it("pads the context bar below the notch and keeps the nav on its layer", () => {
    render(<AppChrome>content</AppChrome>);
    expect(document.querySelector("header")?.className).toContain("pt-[env(safe-area-inset-top)]");
    const tabBar = screen.getByRole("navigation", { name: "Quick sections" });
    expect(tabBar.className).toContain("z-nav");
    expect(Z_LAYERS.nav).toBe(40);
  });
});

describe("floating surfaces on a 390px phone", () => {
  it("CookieBanner sits above the tab bar", () => {
    render(
      <>
        <AppChrome>content</AppChrome>
        <CookieBanner />
      </>,
    );
    const banner = screen.getByRole("dialog", { name: "Cookies & analytics" });
    expect(banner.className).toContain("bottom-above-chrome");
    expect(banner.className).toContain("z-banner");
    expect(Z_LAYERS.banner).toBeGreaterThan(Z_LAYERS.nav);
    // Its bottom edge clears the top of the 64px tab bar, with a gap.
    expect(aboveChromeBottomPx(chromeBottom())).toBeGreaterThan(tabBarHeight);
    expect(aboveChromeBottomPx(chromeBottom())).toBe(76);
  });

  it("toasts sit above the tab bar, on the top layer", () => {
    function Notify() {
      const { toast } = useToast();
      return (
        <button type="button" onClick={() => toast.success("Saved")}>
          Notify
        </button>
      );
    }
    render(
      <ToastProvider>
        <AppChrome>
          <Notify />
        </AppChrome>
      </ToastProvider>,
    );
    act(() => screen.getByRole("button", { name: "Notify" }).click());
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(region.className).toContain("bottom-above-chrome");
    expect(region.className).toContain("z-toast");
    expect(Z_LAYERS.toast).toBeGreaterThan(Z_LAYERS.banner);
  });

  it("Settings' floating save bars all clear the tab bar", () => {
    // SaveBar is shared; Multi-platform chat portals its own bar.
    const dir = path.join(process.cwd(), "components/analyzer/settings");
    const pinnedToBottom = readdirSync(dir)
      .filter((file) => file.endsWith(".tsx"))
      .filter((file) => /fixed inset-x-0 bottom-0/.test(readFileSync(path.join(dir, file), "utf8")));
    expect(pinnedToBottom).toEqual([]);
    expect(readFileSync(path.join(dir, "SettingsMultiChat.tsx"), "utf8")).toContain("bottom-above-chrome z-banner");
  });
});
