import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodayView } from "../TodayView";
import { FiltersContext } from "@/lib/filterContext";
import type { PulseCard } from "@/lib/dailyPulse";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  useApi: vi.fn(() => ({ data: { defaultTab: "battlefield" }, isLoading: false, error: null })),
  firstRunVisible: false,
  totalGames: 42,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: mocks.replace }),
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: mocks.useApi,
}));

vi.mock("@/lib/instant/useInstantImport", () => ({
  useInstantImport: () => ({ enabled: false, mode: "off", loading: false }),
}));

vi.mock("@/components/dashboard/AnalyzerFrame", () => ({
  useDashboardMe: () => ({
    agentPaired: true,
    agentVersion: "1.0.0",
    agentLastSeenAt: null,
    get games() { return { total: mocks.totalGames, latest: null }; },
  }),
  onboardingView: () => ({ checklist: mocks.firstRunVisible, noGamesYet: false }),
}));

vi.mock("@/components/onboarding/LevelUpChecklist", () => ({ LevelUpChecklist: () => <section data-testid="level-up-checklist" /> }));

vi.mock("@/components/dashboard/AgentUpgradeNotice", () => ({
  AgentUpgradeNotice: () => <div data-testid="agent-upgrade" />,
}));

vi.mock("@/components/scouting/LiveScoutingBrief", () => ({
  LiveScoutingBrief: () => <div data-testid="live-game" />,
}));

vi.mock("@/components/analyzer/DashboardKpiStrip", () => ({
  DashboardKpiStrip: () => <div data-testid="kpi-strip" />,
}));

vi.mock("@/components/analyzer/DailyPulse", () => ({
  DailyPulse: ({ hrefForCard }: { hrefForCard?: (card: PulseCard) => string | null }) => <section data-testid="daily-pulse">{hrefForCard ? <a href={hrefForCard({ id: "build", category: "build", tone: "positive", kicker: "Build", title: "Rising build", body: "Recorded", targetTab: "builds", targetQuery: { q: "Forge expand" } }) ?? undefined}>Rising build</a> : null}</section>,
}));

vi.mock("@/components/analyzer/LadderPulse", () => ({
  LadderPulse: () => <section data-testid="ladder-pulse" />,
}));

beforeEach(() => {
  mocks.replace.mockReset();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/app");
  mocks.useApi.mockClear();
  mocks.firstRunVisible = false; mocks.totalGames = 42;
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("TodayView", () => {
  it("mounts one suggested feature card only after games and first-run admission", async () => {
    const view = render(<TodayView />);
    expect(await screen.findAllByTestId("level-up-checklist")).toHaveLength(1);
    mocks.firstRunVisible = true; view.rerender(<TodayView />);
    expect(screen.queryByTestId("level-up-checklist")).toBeNull();
    mocks.firstRunVisible = false; mocks.totalGames = 0; view.rerender(<TodayView />);
    expect(screen.queryByTestId("level-up-checklist")).toBeNull();
  });
  it("passes contextual Pulse hrefs with the complete current global filter snapshot", () => {
    render(<FiltersContext.Provider value={{ filters: { race: "P", map: "Global map", accounts: "1-S2-1-42" }, setFilters: vi.fn(), dbRev: 0, bumpRev: vi.fn(), seasons: [] }}><TodayView /></FiltersContext.Provider>);
    const url = new URL(screen.getByRole("link", { name: "Rising build" }).getAttribute("href")!, "http://fixture.invalid");
    expect(url.pathname).toBe("/app/builds");
    expect(url.searchParams.get("q")).toBe("Forge expand");
    expect(url.searchParams.get("map")).toBe("Global map");
    expect(url.searchParams.get("accounts")).toBe("1-S2-1-42");
    expect(url.searchParams.get("filters")).toBe("1");
  });
  it("places Daily Pulse above Ladder Pulse", async () => {
    render(<TodayView />);

    const daily = screen.getByTestId("daily-pulse");
    const ladder = await screen.findByTestId("ladder-pulse");
    expect(
      daily.compareDocumentPosition(ladder) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("TodayView default tab", () => {
  // Settings → "Default tab" moved to the /app page on the server
  // (app/app/page.tsx), so Today itself never bounces you away.
  it("never redirects, whatever the saved default tab", () => {
    render(<TodayView />);
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("daily-pulse")).toBeTruthy();
  });

  it("keeps the Today launcher shortcut on Today despite a saved default section", () => {
    window.history.replaceState(null, "", "/app?view=today");
    render(<TodayView />);
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("daily-pulse")).toBeTruthy();
    // Once Today was chosen explicitly, returning to it stays there this session.
    cleanup();
    window.history.replaceState(null, "", "/app");
    render(<TodayView />);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("no longer asks for the misc preferences", () => {
    render(<TodayView />);
    const paths = mocks.useApi.mock.calls.map((call) => (call as unknown[])[0]);
    expect(paths).not.toContain("/v1/me/preferences/misc");
  });
});

// These consumer assertions retain their original scope; tour owner/route/focus behavior is tested separately.
vi.mock("@/components/onboarding/GuidedTours", () => ({ GuidedTours: ({ children, className, id }: { children: import("react").ReactNode; className?: string; id: string }) => <div className={className} data-tour-surface={id}>{children}</div> }));