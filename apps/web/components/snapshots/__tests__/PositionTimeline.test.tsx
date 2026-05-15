import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { PositionTimeline } from "../PositionTimeline";
import type { GameTick } from "../shared/snapshotTypes";

afterEach(() => cleanup());

function makeTick(t: number, verdict: GameTick["verdict"]): GameTick {
  return {
    t,
    my: { value: {}, scores: {}, aggregateScore: 0 },
    opp: { value: {}, scores: {}, aggregateScore: 0 },
    verdict,
    compositionDelta: null,
  };
}

describe("PositionTimeline", () => {
  it("renders one cell per tick with the verdict glyph", () => {
    const ticks = [
      makeTick(0, "neutral"),
      makeTick(30, "winning"),
      makeTick(60, "losing"),
    ];
    render(
      <PositionTimeline ticks={ticks} focusedTick={null} onFocus={() => {}} />,
    );
    expect(screen.getByLabelText(/0:00.*Neutral/i)).toBeTruthy();
    expect(screen.getByLabelText(/0:30.*Winning/i)).toBeTruthy();
    expect(screen.getByLabelText(/1:00.*Losing/i)).toBeTruthy();
  });

  it("invokes onFocus when a cell is clicked", () => {
    const onFocus = vi.fn();
    render(
      <PositionTimeline
        ticks={[makeTick(60, "winning")]}
        focusedTick={null}
        onFocus={onFocus}
      />,
    );
    fireEvent.click(screen.getByLabelText(/1:00/));
    expect(onFocus).toHaveBeenCalledWith(60);
  });

  it("marks the focused tick with aria-selected", () => {
    render(
      <PositionTimeline
        ticks={[makeTick(60, "neutral")]}
        focusedTick={60}
        onFocus={() => {}}
      />,
    );
    const cell = screen.getByLabelText(/1:00/);
    expect(cell.getAttribute("aria-selected")).toBe("true");
  });
});
