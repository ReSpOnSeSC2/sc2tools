/**
 * AnalyzerFrame — the onboarding gate on /app: the agent checklist vs the
 * zero-games choice (desktop agent | browser import) and background
 * Folder Sync only when browser import is enabled. Router, sockets, the
 * analyzer provider, the filter bar and the Folder Sync runner are MOCKS.
 */
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ browserImport: false, pathname: "/app" }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => mocks.pathname }));
vi.mock("next/dynamic", () => ({
  default: () =>
    function FolderSyncAutoRunnerMock() {
      return <div data-testid="folder-sync-auto-runner" />;
    },
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "token" }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: vi.fn() }));
vi.mock("@/components/AnalyzerProvider", () => ({ AnalyzerProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/analyzer/DoctorBanner", () => ({ DoctorBanner: () => null }));
vi.mock("@/components/analyzer/FilterBar", () => ({ FilterBar: () => null }));
vi.mock("@/components/analyzer/ActiveFilterChips", () => ({
  ActiveFilterChips: () => <div data-testid="active-filter-chips" />,
}));
vi.mock("@/components/imports/useImportStatus", () => ({
  useImportStatus: () => ({ job: null, active: false, pct: 0, etaSeconds: null, isLoading: false, refresh: vi.fn() }),
}));
vi.mock("@/lib/instant/useInstantImport", () => ({
  useInstantImport: () => ({ enabled: mocks.browserImport, mode: mocks.browserImport ? "all" : "off", loading: false }),
}));
vi.mock("@/lib/useUserSocket", () => ({ useUserSocket: vi.fn() }));

import { AnalyzerFrame, onboardingView, type DashboardMe } from "../AnalyzerFrame";

const NEW_USER: DashboardMe = { userId: "u1", source: "cloud", games: { total: 0, latest: null }, agentPaired: false };

beforeEach(() => {
  mocks.browserImport = false;
  mocks.pathname = "/app";
});

afterEach(cleanup);

describe("onboardingView", () => {
  it("shows both options to a new account that has not started the agent path", () => {
    expect(onboardingView(NEW_USER, true)).toEqual({ checklist: false, noGamesYet: true });
  });

  it("keeps the checklist for the agent path and when browser import is off", () => {
    expect(onboardingView(NEW_USER, false)).toEqual({ checklist: true, noGamesYet: false });
    expect(onboardingView({ ...NEW_USER, agentPaired: true }, true)).toEqual({ checklist: true, noGamesYet: false });
    const started = { ...NEW_USER, onboarding: { downloadStartedAt: "2026-09-01T00:00:00Z" } };
    expect(onboardingView(started, true)).toEqual({ checklist: true, noGamesYet: false });
  });

  it("gets out of the way once games exist", () => {
    const withGames: DashboardMe = { ...NEW_USER, games: { total: 3, latest: null } };
    expect(onboardingView(withGames, true)).toEqual({ checklist: false, noGamesYet: false });
  });
});

describe("AnalyzerFrame", () => {
  it("renders the side-by-side choice for a new browser-import account", () => {
    mocks.browserImport = true;
    render(<AnalyzerFrame me={NEW_USER}>PAGE</AnalyzerFrame>);
    expect(screen.getByRole("link", { name: "Install the desktop agent" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Import in your browser — no download" })).toBeTruthy();
    expect(screen.queryByTestId("onboarding-checklist")).toBeNull();
    expect(screen.queryByText("PAGE")).toBeNull();
    expect(screen.getByTestId("folder-sync-auto-runner")).toBeTruthy();
  });

  it("keeps the agent checklist, and no Folder Sync, with browser import off", () => {
    render(<AnalyzerFrame me={NEW_USER}>PAGE</AnalyzerFrame>);
    expect(screen.getByTestId("onboarding-checklist")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Import in your browser — no download" })).toBeNull();
    expect(screen.queryByTestId("folder-sync-auto-runner")).toBeNull();
  });

  it("renders the section once games exist", () => {
    render(<AnalyzerFrame me={{ ...NEW_USER, agentPaired: true, games: { total: 5, latest: null } }}>PAGE</AnalyzerFrame>);
    expect(screen.getByText("PAGE")).toBeTruthy();
  });

  it("shows the Active filters row under the filter bar on every analyzer route", () => {
    const me = { ...NEW_USER, agentPaired: true, games: { total: 5, latest: null } };
    for (const pathname of ["/app", "/app/opponents", "/app/opponents/123", "/app/strategies"]) {
      mocks.pathname = pathname;
      render(<AnalyzerFrame me={me}>PAGE</AnalyzerFrame>);
      expect(screen.getByTestId("active-filter-chips"), pathname).toBeTruthy();
      cleanup();
    }
  });

  it("marks the browser session on mount, so Today stops applying the default tab", () => {
    document.cookie = "sc2_app_session=; Max-Age=0; Path=/";
    expect(document.cookie).not.toContain("sc2_app_session=1");
    mocks.pathname = "/app/maps";
    render(<AnalyzerFrame me={{ ...NEW_USER, agentPaired: true, games: { total: 5, latest: null } }}>PAGE</AnalyzerFrame>);
    expect(document.cookie).toContain("sc2_app_session=1");
  });

  it("leaves the Active filters row off the single-game page", () => {
    mocks.pathname = "/app/game/abc";
    render(<AnalyzerFrame me={{ ...NEW_USER, agentPaired: true, games: { total: 5, latest: null } }}>PAGE</AnalyzerFrame>);
    expect(screen.getByText("PAGE")).toBeTruthy();
    expect(screen.queryByTestId("active-filter-chips")).toBeNull();
  });
});
