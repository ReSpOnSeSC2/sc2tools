import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { AnalyzerShell } from "../AnalyzerShell";

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
vi.mock("../DailyPulse", () => ({
  DailyPulse: ({
    onOpenOpponent,
  }: {
    onOpenOpponent?: (pulseId: string) => void;
  }) => (
    <button type="button" onClick={() => onOpenOpponent?.("opp-nemesis")}>
      Open nemesis
    </button>
  ),
}));
vi.mock("../DashboardKpiStrip", () => ({ DashboardKpiStrip: () => null }));
vi.mock("../DoctorBanner", () => ({ DoctorBanner: () => null }));
vi.mock("../FilterBar", () => ({ FilterBar: () => null }));
vi.mock("../LadderPulse", () => ({
  LadderPulse: () => <div>Ladder pulse</div>,
}));
vi.mock("../MacroTab", () => ({ MacroTab: () => null }));
vi.mock("../StrategiesTab", () => ({ StrategiesTab: () => null }));
vi.mock("../TrendsTab", () => ({ TrendsTab: () => null }));

afterEach(cleanup);

describe("AnalyzerShell opponent hydration", () => {
  it("enables full replay history only while Arcade is open", () => {
    const view = render(
      <AnalyzerShell totalGames={50} tab="trends" onTabChange={() => undefined} />,
    );
    expect(screen.getByTestId("analyzer-provider").getAttribute("data-corpus-active"))
      .toBe("false");

    view.rerender(
      <AnalyzerShell totalGames={50} tab="arcade" onTabChange={() => undefined} />,
    );
    expect(screen.getByTestId("analyzer-provider").getAttribute("data-corpus-active"))
      .toBe("true");
  });

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
    expect(screen.getByText("Ladder pulse")).toBeTruthy();
    expect(screen.queryByText("Opponent list")).toBeNull();
  });

  it("a Daily Pulse opponent card opens the dossier from another tab", () => {
    const onTabChange = vi.fn();
    const { rerender } = render(
      <AnalyzerShell
        totalGames={50}
        tab="trends"
        onTabChange={onTabChange}
      />,
    );

    fireEvent.click(screen.getByText("Open nemesis"));
    expect(onTabChange).toHaveBeenCalledWith("opponents");

    // The parent flips the tab prop; the pending dossier must survive
    // the tab-sync effect instead of being reset to the opponents list.
    rerender(
      <AnalyzerShell
        totalGames={50}
        tab="opponents"
        onTabChange={onTabChange}
      />,
    );
    expect(screen.getByText("Hydrated opponent opp-nemesis")).toBeTruthy();
    expect(screen.queryByText("Opponent list")).toBeNull();
  });

  it("a Daily Pulse opponent card opens the dossier while already on the opponents tab", () => {
    render(
      <AnalyzerShell
        totalGames={50}
        tab="opponents"
        onTabChange={() => undefined}
      />,
    );
    expect(screen.getByText("Opponent list")).toBeTruthy();

    fireEvent.click(screen.getByText("Open nemesis"));
    expect(screen.getByText("Hydrated opponent opp-nemesis")).toBeTruthy();
  });
});
