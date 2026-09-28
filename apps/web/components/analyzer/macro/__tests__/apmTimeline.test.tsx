import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MacroChartSection } from "../MacroChartSection";
import { MacroKpiRow } from "../MacroKpiRow";
import type { StatsEvent } from "../MacroBreakdownPanel.types";
import { readGameApm, type ApmCurveResponse, type GameApm } from "@/lib/apm";
import realCurves from "@/lib/__tests__/fixtures/apmCurves.json";

/**
 * APM in the macro breakdown: an APM view on the Match timeline switch
 * (only when the game has a trusted curve) and an APM tile beside SQ.
 */

const useApiMock = vi.fn();
vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

const samples: StatsEvent[] = [
  { time: 0, army_value: 0, food_workers: 12 },
  { time: 150, army_value: 1400, food_workers: 36 },
  { time: 300, army_value: 3000, food_workers: 48 },
];

const windows = (values: number[]) => values.map((apm, i) => ({ t: i * 30, apm, spm: null }));
const APM: GameApm = {
  windowSec: 30,
  me: { avg: 190, avgSpm: 31, samples: windows([120, 160, 180, 190, 200, 200, 190, 200, 210, 210]) },
  opp: { avg: 250, avgSpm: 48, samples: windows([150, 220, 240, 250, 260, 270, 260, 250, 250, 250]) },
};

function Section({ apm, gameId = "g1" }: { apm: GameApm | null; gameId?: string }) {
  return (
    <MacroChartSection
      gameId={gameId}
      samples={samples}
      oppSamples={samples}
      leaks={[]}
      gameLengthSec={300}
      myName="ReSpOnSe"
      oppName="Squirtuoz"
      myRace="Protoss"
      apm={apm}
    />
  );
}

function readout() {
  return screen.getByText("Game time").closest("dl") as HTMLElement;
}

/** The read-out's "Game average" cells, in column order (you, opponent). */
function averageCells() {
  return Array.from(readout().querySelectorAll("dd.flex-wrap")).map((el) => el.textContent);
}

beforeEach(() => {
  useApiMock.mockReturnValue({ data: null, error: null, isLoading: false });
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [{ target, contentRect: new DOMRect(0, 0, 600, 220) }] as ResizeObserverEntry[],
        this as unknown as ResizeObserver,
      );
    }
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useApiMock.mockReset();
});

describe("Match timeline APM view", () => {
  it("is not offered when the game has no trusted APM", () => {
    render(<Section apm={null} />);
    expect(screen.queryByRole("button", { name: "APM" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^(Army|Workers|Supply|Income)$/ })).toHaveLength(4);
  });

  it("plots both players' APM with the leader's margin", () => {
    render(<Section apm={APM} />);
    const button = screen.getByRole("button", { name: "APM" });
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("img", { name: /^Actions per minute/ })).toBeTruthy();
    // Game end: 210 for you, 250 for the opponent, who leads by 40.
    expect(readout().textContent).toContain("210");
    expect(readout().textContent).toContain("250");
    expect(readout().textContent).toContain("+40");
  });

  it("shows each player's game-average APM and SPM under the APM view only", () => {
    // The warpgate fixture replay: ReSpOnSe 189.7 APM / 28.7 SPM,
    // Squirtuoz 281.5 APM / 53.9 SPM.
    const real = readGameApm(realCurves.warpgate_adept_tracking.response as ApmCurveResponse);
    render(<Section apm={real} />);
    expect(screen.queryByText("Game average")).toBeNull(); // Army view
    fireEvent.click(screen.getByRole("button", { name: "APM" }));
    expect(screen.getByText("Game average")).toBeTruthy();
    expect(averageCells()).toEqual(["190 APM29 SPM", "282 APM54 SPM"]);
    fireEvent.click(screen.getByRole("button", { name: "Workers" }));
    expect(screen.queryByText("Game average")).toBeNull();
  });

  it("shows a dash for an average the game can't provide", () => {
    render(<Section apm={{ ...APM, opp: null, me: { ...APM.me, avgSpm: null } }} />);
    fireEvent.click(screen.getByRole("button", { name: "APM" }));
    expect(averageCells()).toEqual(["190 APM— SPM", "— APM— SPM"]);
  });

  it("falls back to Army when the next game has no APM", () => {
    const { rerender } = render(<Section apm={APM} />);
    fireEvent.click(screen.getByRole("button", { name: "APM" }));
    rerender(<Section apm={null} gameId="g2" />);
    expect(screen.queryByRole("button", { name: "APM" })).toBeNull();
    expect(screen.getByRole("button", { name: "Army" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("APM tile", () => {
  const raw = { sq: 82.4, supply_blocked_seconds: 4, mineral_float_spikes: 0 };

  it("shows your average with the opponent's beneath", () => {
    render(<MacroKpiRow raw={raw} apm={APM} apmLoading={false} />);
    const tile = screen.getByText("APM").closest("div")!.parentElement!;
    expect(tile.textContent).toContain("190");
    expect(tile.textContent).toContain("Opponent 250");
  });

  it("says when APM wasn't measured, and explains how to add it", () => {
    render(<MacroKpiRow raw={raw} apm={null} apmLoading={false} />);
    const tile = screen.getByText("APM").closest("div")!.parentElement!;
    expect(tile.textContent).toContain("—");
    expect(tile.textContent).toContain("Not measured for this game");
    fireEvent.click(screen.getByRole("button", { name: "Show APM explanation" }));
    expect(screen.getByRole("note").textContent).toMatch(/Recompute/);
  });

  it("stays quiet while the curve is loading", () => {
    render(<MacroKpiRow raw={raw} apm={null} apmLoading />);
    expect(screen.queryByText("Not measured for this game")).toBeNull();
  });
});
