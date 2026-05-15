import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CounterSuggestionList } from "../CounterSuggestion";

afterEach(() => cleanup());

describe("CounterSuggestionList", () => {
  it("renders both strategy types side-by-side", () => {
    render(
      <CounterSuggestionList
        suggestions={[
          {
            strategy: "switch_composition",
            targetClusterId: "immortal_sentry",
            targetClusterLabel: "Immortal/Sentry",
            projectedWinRate: 0.74,
            projectedWinRateCI: [0.68, 0.8],
            sampleSize: 63,
            unitsToAdd: { Immortal: 3, Sentry: 1 },
            unitsToRemove: { Phoenix: 2 },
          },
          {
            strategy: "switch_tech_path",
            currentPathId: "stargate_only",
            targetPathId: "stargate_robo",
            targetPathLabel: "Stargate + Robo",
            projectedWinRate: 0.67,
            projectedWinRateCI: [0.6, 0.73],
            sampleSize: 71,
            buildingsToAdd: ["RoboticsFacility"],
          },
        ]}
        currentWinRate={0.58}
      />,
    );
    expect(screen.getByText(/Immortal\/Sentry/)).toBeTruthy();
    expect(screen.getByText(/Stargate \+ Robo/)).toBeTruthy();
    expect(screen.getAllByText(/74%/)[0]).toBeTruthy();
    expect(screen.getByText(/\+3 Immortal/i)).toBeTruthy();
    expect(screen.getByText(/-2 Phoenix/i)).toBeTruthy();
    expect(screen.getByText(/\+RoboticsFacility/)).toBeTruthy();
  });

  it("renders empty state when no suggestions", () => {
    render(<CounterSuggestionList suggestions={[]} />);
    expect(screen.getByText(/already competitive/i)).toBeTruthy();
  });

  it("shows delta vs current win rate", () => {
    render(
      <CounterSuggestionList
        suggestions={[
          {
            strategy: "switch_composition",
            targetClusterId: "x",
            targetClusterLabel: "X",
            projectedWinRate: 0.7,
            projectedWinRateCI: [0.6, 0.8],
            sampleSize: 30,
            unitsToAdd: { Stalker: 2 },
          },
        ]}
        currentWinRate={0.5}
      />,
    );
    expect(screen.getByText(/\+20% vs current/)).toBeTruthy();
  });
});
