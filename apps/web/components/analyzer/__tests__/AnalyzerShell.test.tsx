import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { AnalyzerShell } from "../AnalyzerShell";

vi.mock("@/components/AnalyzerProvider", () => ({
  AnalyzerProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../ProfileView", () => ({
  ProfileView: ({ pulseId }: { pulseId: string }) => (
    <div>Hydrated opponent {pulseId}</div>
  ),
}));
vi.mock("../OpponentsTab", () => ({
  OpponentsTab: () => <div>Opponent list</div>,
}));
vi.mock("../ArcadeTab", () => ({ ArcadeTab: () => null }));
vi.mock("../BattlefieldTab", () => ({ BattlefieldTab: () => null }));
vi.mock("../BuildsTab", () => ({ BuildsTab: () => null }));
vi.mock("../DashboardKpiStrip", () => ({ DashboardKpiStrip: () => null }));
vi.mock("../DoctorBanner", () => ({ DoctorBanner: () => null }));
vi.mock("../FilterBar", () => ({ FilterBar: () => null }));
vi.mock("../MacroTab", () => ({ MacroTab: () => null }));
vi.mock("../StrategiesTab", () => ({ StrategiesTab: () => null }));
vi.mock("../TrendsTab", () => ({ TrendsTab: () => null }));

afterEach(cleanup);

describe("AnalyzerShell opponent hydration", () => {
  it("opens the requested opponent profile instead of the opponents list", () => {
    render(
      <AnalyzerShell
        totalGames={50}
        tab="opponents"
        onTabChange={() => undefined}
        initialOpponentId="1-S2-1-99"
      />,
    );

    expect(screen.getByText("Hydrated opponent 1-S2-1-99")).toBeTruthy();
    expect(screen.queryByText("Opponent list")).toBeNull();
  });
});
