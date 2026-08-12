import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const useApiMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

vi.mock("../ActiveArmyChart", () => ({
  ActiveArmyChart: ({
    hoveredTime,
    onHover,
  }: {
    hoveredTime?: number | null;
    onHover?: (
      event:
        | { type: "hover"; time: number }
        | { type: "tap"; time: number }
        | { type: "leave" },
    ) => void;
  }) => (
    <div>
      <output data-testid="chart-time">{hoveredTime ?? "none"}</output>
      <button
        type="button"
        onClick={() => onHover?.({ type: "hover", time: 75 })}
      >
        Hover at 1:15
      </button>
      <button type="button" onClick={() => onHover?.({ type: "leave" })}>
        Leave graph
      </button>
      <button
        type="button"
        onClick={() => onHover?.({ type: "hover", time: 140 })}
      >
        Hover at 2:20
      </button>
    </div>
  ),
}));

vi.mock("../CompositionSnapshot", () => ({
  CompositionSnapshot: ({ hoveredTime }: { hoveredTime?: number | null }) => (
    <output data-testid="composition-time">{hoveredTime ?? "none"}</output>
  ),
}));

import { MacroChartSection } from "../MacroChartSection";

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
});

describe("MacroChartSection mouse selection", () => {
  it("keeps the last time and crosshair locked when the pointer leaves", () => {
    useApiMock.mockReturnValue({
      data: null,
      error: null,
      isLoading: false,
    });

    render(
      <MacroChartSection
        samples={[]}
        oppSamples={[]}
        leaks={[]}
        gameLengthSec={300}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Hover at 1:15" }));
    expect(screen.getByTestId("chart-time").textContent).toBe("75");
    expect(screen.getByTestId("composition-time").textContent).toBe("75");

    fireEvent.click(screen.getByRole("button", { name: "Leave graph" }));
    expect(screen.getByTestId("chart-time").textContent).toBe("75");
    expect(screen.getByTestId("composition-time").textContent).toBe("75");

    // The retained mouse selection is not touch-style sticky: re-entering
    // the graph immediately resumes normal cursor tracking.
    fireEvent.click(screen.getByRole("button", { name: "Hover at 2:20" }));
    expect(screen.getByTestId("chart-time").textContent).toBe("140");
    expect(screen.getByTestId("composition-time").textContent).toBe("140");
  });
});
