import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TodayView } from "../TodayView";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: () => ({ data: undefined, isLoading: false, error: null }),
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
