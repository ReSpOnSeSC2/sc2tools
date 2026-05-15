import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CompositionMatchupMatrix } from "../CompositionMatchupMatrix";
import type { CompositionMatchupBlock } from "../shared/snapshotTypes";

afterEach(() => cleanup());

const SAMPLE_BLOCK: CompositionMatchupBlock = {
  myCluster: {
    id: "stargate_heavy",
    label: "Stargate-heavy",
    centroid: { Stalker: 8, Phoenix: 6 },
    distanceFromCentroid: 0.18,
    secondClosest: null,
  },
  oppCluster: {
    id: "roach_ravager",
    label: "Roach/Ravager",
    centroid: { Roach: 12, Ravager: 3 },
    distanceFromCentroid: 0.22,
  },
  winRate: 0.58,
  winRateCI: [0.51, 0.65],
  neutralBand: [0.4, 0.6],
  verdict: "favorable",
  sampleSize: 84,
  fullRow: [
    { oppClusterId: "roach_ravager", oppLabel: "Roach/Ravager", winRate: 0.58, sampleSize: 84 },
    { oppClusterId: "ling_bane", oppLabel: "Ling/Bane", winRate: 0.72, sampleSize: 61 },
  ],
  fullMatrix: {
    myClusters: ["stargate_heavy", "blink_stalker"],
    oppClusters: ["roach_ravager", "ling_bane"],
    rows: [
      [
        { winRate: 0.58, sampleSize: 84, ci: [0.51, 0.65] },
        { winRate: 0.72, sampleSize: 61, ci: [0.65, 0.78] },
      ],
      [
        { winRate: 0.41, sampleSize: 39, ci: [0.32, 0.5] },
        { winRate: 0.53, sampleSize: 27, ci: [0.42, 0.63] },
      ],
    ],
  },
  counterSuggestions: [],
};

describe("CompositionMatchupMatrix", () => {
  it("renders all K×K cells with cohort win rates", () => {
    render(<CompositionMatchupMatrix block={SAMPLE_BLOCK} />);
    // 4 cells in 2×2 with rounded percentages.
    expect(screen.getAllByText(/58%/)[0]).toBeTruthy();
    expect(screen.getByText(/72%/)).toBeTruthy();
    expect(screen.getByText(/41%/)).toBeTruthy();
    expect(screen.getByText(/53%/)).toBeTruthy();
  });

  it("emits onCellSelect when a cell is clicked", () => {
    const onCellSelect = vi.fn();
    render(<CompositionMatchupMatrix block={SAMPLE_BLOCK} onCellSelect={onCellSelect} />);
    const cell = screen.getByLabelText(/Stargate-heavy vs Roach\/Ravager/i);
    fireEvent.click(cell);
    expect(onCellSelect).toHaveBeenCalledWith("stargate_heavy", "roach_ravager");
  });

  it("shows empty-state when block is null", () => {
    render(<CompositionMatchupMatrix block={null} />);
    expect(screen.getByText(/No composition matrix/i)).toBeTruthy();
  });
});
