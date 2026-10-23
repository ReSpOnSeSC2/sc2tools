import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodayView } from "../TodayView";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  useApi: vi.fn(() => ({ data: { defaultTab: "battlefield" }, isLoading: false, error: null })),
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
    games: { total: 42, latest: null },
  }),
}));

vi.mock("@/components/dashboard/AgentUpgradeNotice", () => ({
  AgentUpgradeNotice: () => <div data-testid="agent-upgrade" />,
}));

vi.mock("@/components/dashboard/LiveGamePanel", () => ({
  LiveGamePanel: () => <div data-testid="live-game" />,
}));

vi.mock("@/components/analyzer/DashboardKpiStrip", () => ({
  DashboardKpiStrip: () => <div data-testid="kpi-strip" />,
}));

vi.mock("@/components/analyzer/DailyPulse", () => ({
  DailyPulse: () => <section data-testid="daily-pulse" />,
}));

vi.mock("@/components/analyzer/LadderPulse", () => ({
  LadderPulse: () => <section data-testid="ladder-pulse" />,
}));

beforeEach(() => {
  mocks.replace.mockReset();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/app");
  mocks.useApi.mockClear();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("TodayView", () => {
  it("places Daily Pulse above Ladder Pulse", () => {
    render(<TodayView />);

    const daily = screen.getByTestId("daily-pulse");
    const ladder = screen.getByTestId("ladder-pulse");
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
