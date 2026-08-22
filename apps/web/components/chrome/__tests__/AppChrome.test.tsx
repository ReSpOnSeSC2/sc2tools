import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { AppChrome, type DashboardMe } from "../AppChrome";

const navHarness = vi.hoisted(() => ({ pathname: "/app" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navHarness.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@clerk/nextjs", () => ({
  UserButton: () => <div data-testid="user-button" />,
}));
vi.mock("@/components/AnalyzerProvider", () => ({
  AnalyzerProvider: ({
    children,
    analysisGamesEnabled,
  }: {
    children: ReactNode;
    analysisGamesEnabled?: boolean;
  }) => (
    <div data-testid="analyzer-provider" data-corpus-active={analysisGamesEnabled}>
      {children}
    </div>
  ),
}));
vi.mock("@/components/analyzer/DoctorBanner", () => ({
  DoctorBanner: () => null,
}));
vi.mock("@/components/analyzer/FilterBar", () => ({
  FilterBar: () => <div data-testid="filter-bar" />,
}));
vi.mock("@/components/SyncStatus", () => ({ SyncStatus: () => null }));
vi.mock("@/components/ui/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/lib/useUserSocket", () => ({ useUserSocket: () => undefined }));
vi.mock("@/components/onboarding/OnboardingChecklist", async () => {
  const actual = await vi.importActual<
    typeof import("@/components/onboarding/OnboardingChecklist")
  >("@/components/onboarding/OnboardingChecklist");
  return {
    checklistVisible: actual.checklistVisible,
    OnboardingChecklist: () => <div data-testid="onboarding-checklist" />,
  };
});
vi.mock("@/components/imports/useImportStatus", () => ({
  useImportStatus: () => ({ active: false, job: null }),
}));
vi.mock("@/components/imports/ImportProgressCard", () => ({
  ImportProgressCard: () => null,
}));

afterEach(() => {
  cleanup();
  navHarness.pathname = "/app";
});

const ME: DashboardMe = {
  userId: "user-1",
  source: "cloud",
  games: { total: 50, latest: "2026-07-12T00:00:00Z" },
  agentPaired: true,
  onboarding: { dismissedAt: "2026-05-01T00:00:00Z" },
};

describe("AppChrome", () => {
  it("renders the routed section inside the chrome with every rail destination", () => {
    navHarness.pathname = "/app/macro";
    render(
      <AppChrome me={ME}>
        <div>SECTION CONTENT</div>
      </AppChrome>,
    );

    expect(screen.getByText("SECTION CONTENT")).toBeTruthy();
    const rail = screen.getByRole("navigation", { name: "App navigation" });
    const hrefs = Array.from(rail.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    for (const expected of [
      "/app",
      "/app/opponents",
      "/app/strategies",
      "/app/trends",
      "/app/macro",
      "/app/maps",
      "/app/builds",
      "/app/arcade",
      "/builds",
      "/devices",
      "/settings",
    ]) {
      expect(hrefs).toContain(expected);
    }
    // Admin stays hidden unless /v1/me grants it.
    expect(hrefs).not.toContain("/admin");
  });

  it("marks the active section and scopes the arcade-only replay corpus", () => {
    navHarness.pathname = "/app/arcade";
    render(
      <AppChrome me={{ ...ME, isAdmin: true }}>
        <div>ARCADE</div>
      </AppChrome>,
    );

    const rail = screen.getByRole("navigation", { name: "App navigation" });
    const active = rail.querySelector('a[aria-current="page"]');
    expect(active?.getAttribute("href")).toBe("/app/arcade");
    expect(
      screen
        .getByTestId("analyzer-provider")
        .getAttribute("data-corpus-active"),
    ).toBe("true");
    expect(
      Array.from(rail.querySelectorAll("a")).map((a) => a.getAttribute("href")),
    ).toContain("/admin");
  });

  it("replaces section content with the onboarding checklist until the funnel completes", () => {
    render(
      <AppChrome
        me={{
          ...ME,
          games: { total: 0, latest: null },
          agentPaired: false,
          onboarding: null,
        }}
      >
        <div>SECTION CONTENT</div>
      </AppChrome>,
    );

    expect(screen.getByTestId("onboarding-checklist")).toBeTruthy();
    expect(screen.queryByText("SECTION CONTENT")).toBeNull();
  });

  it("shows the zero-games empty state once onboarding is dismissed", () => {
    render(
      <AppChrome
        me={{
          ...ME,
          games: { total: 0, latest: null },
          agentPaired: true,
        }}
      >
        <div>SECTION CONTENT</div>
      </AppChrome>,
    );

    expect(screen.getByTestId("dashboard-no-games")).toBeTruthy();
    expect(screen.queryByText("SECTION CONTENT")).toBeNull();
  });

  it("gives the replay analysis route the chrome without the analyzer filter row", () => {
    navHarness.pathname = "/app/game/g-123";
    render(
      <AppChrome me={ME}>
        <div>GAME DETAIL</div>
      </AppChrome>,
    );

    expect(screen.getByText("GAME DETAIL")).toBeTruthy();
    expect(screen.queryByTestId("filter-bar")).toBeNull();
  });
});
