import { describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { CompositionDeltaTable } from "../CompositionDeltaTable";
import type { GameTick } from "../shared/snapshotTypes";

afterEach(() => cleanup());

function makeTick(): GameTick {
  return {
    t: 360,
    my: { value: {}, scores: {}, aggregateScore: 0 },
    opp: { value: {}, scores: {}, aggregateScore: 0 },
    verdict: "neutral",
    compositionDelta: {
      my: [
        { unit: "Stalker", mine: 8, cohortWinnerMedian: 4, delta: 4, percentile: 0.9 },
        { unit: "Phoenix", mine: 0, cohortWinnerMedian: 3, delta: -3, percentile: 0.1 },
        { unit: "Probe", mine: 60, cohortWinnerMedian: 58, delta: 2, percentile: 0.55 },
      ],
      opp: [],
      mySimilarity: 0.82,
      oppSimilarity: 0.65,
    },
  };
}

describe("CompositionDeltaTable", () => {
  it("renders empty message when no tick is focused", () => {
    render(
      <CompositionDeltaTable focusedTick={null} ticks={[makeTick()]} side="my" />,
    );
    expect(screen.getByText(/Tap a tick/i)).toBeTruthy();
  });

  it("shows rows sorted by absolute delta on the focused tick", () => {
    render(
      <CompositionDeltaTable focusedTick={360} ticks={[makeTick()]} side="my" />,
    );
    const rows = screen.getAllByRole("row");
    // First row is the header
    expect(rows[1].textContent).toMatch(/Stalker/);
    expect(rows[2].textContent).toMatch(/Phoenix/);
    expect(rows[3].textContent).toMatch(/Probe/);
  });

  it("flips sort direction on header click", () => {
    render(
      <CompositionDeltaTable focusedTick={360} ticks={[makeTick()]} side="my" />,
    );
    const unitHeader = screen.getByRole("button", { name: /Unit/i });
    fireEvent.click(unitHeader);
    const rows = screen.getAllByRole("row");
    // Now alphabetical asc: Phoenix, Probe, Stalker
    expect(rows[1].textContent).toMatch(/Phoenix/);
    expect(rows[2].textContent).toMatch(/Probe/);
    expect(rows[3].textContent).toMatch(/Stalker/);
  });

  it("shows similarity percentage", () => {
    render(
      <CompositionDeltaTable focusedTick={360} ticks={[makeTick()]} side="my" />,
    );
    expect(screen.getByText(/82%/)).toBeTruthy();
  });
});
