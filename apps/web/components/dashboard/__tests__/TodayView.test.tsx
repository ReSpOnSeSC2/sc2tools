import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodayView } from "../TodayView";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  misc: undefined as { defaultTab?: string } | undefined,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: mocks.replace }),
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: () => ({ data: mocks.misc, isLoading: false, error: null }),
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
  mocks.misc = undefined;
  window.sessionStorage.clear();
});

afterEach(cleanup);

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
  it("opens the chosen section once per visit", () => {
    mocks.misc = { defaultTab: "battlefield" };
    render(<TodayView />);
    expect(mocks.replace).toHaveBeenCalledWith("/app/maps");
    cleanup();
    render(<TodayView />);
    expect(mocks.replace).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Today (default)", { defaultTab: "today" }],
    ["no choice", {}],
    ["a section that no longer exists", { defaultTab: "ml" }],
  ])("stays on Today for %s", (_label, misc) => {
    mocks.misc = misc;
    render(<TodayView />);
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("daily-pulse")).toBeTruthy();
  });
});
